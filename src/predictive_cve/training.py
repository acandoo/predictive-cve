"""Train zero-inflated count models from the project's SQLite database."""

from __future__ import annotations

import argparse
import os
import sqlite3
from dataclasses import dataclass
from typing import Any, Optional, Sequence

import pandas as pd
import statsmodels.api as sm
from dotenv import load_dotenv
from statsmodels.discrete.count_model import (
    ZeroInflatedNegativeBinomialP,
    ZeroInflatedPoisson,
)

TARGET = "cves_reported_365d"
PREDICTORS = (
    "cov_inter_commit_90d",
    "cov_inter_commit_365d",
    "cov_inter_commit_all",
    "cov_inter_tag_90d",
    "cov_inter_tag_365d",
    "cov_inter_tag_all",
    "contributors_90d",
    "contributors_365d",
    "contributors_all",
    "commits_90d",
    "commits_365d",
    "commits_all",
    "bus_factor_90d",
    "bus_factor_365d",
    "bus_factor_all",
    "top_contributor_share_90d",
    "top_contributor_share_365d",
    "top_contributor_share_all",
    "new_contributor_rate_90d",
    "new_contributor_rate_365d",
    "new_contributor_rate_all",
    "churn_90d",
    "churn_365d",
    "churn_all",
    "repo_age_days",
    "loc",
    "file_count",
    "scorecard_binary_artifacts",
    "scorecard_dangerous_workflow",
    "scorecard_vulnerabilities",
    "scorecard_license",
    "scorecard_pinned_dependencies",
    "scorecard_token_permissions",
    "scorecard_security_policy",
)

@dataclass
class TrainedModel:
    """A fitted model and the columns used to fit it."""

    name: str
    target: str
    feature_columns: list[str]
    rows: int
    result: Any
    preprocessor: "FeaturePreprocessor"

    def predict(self, data: pd.DataFrame) -> pd.Series:
        """Return expected target counts for new rows."""
        features = self.preprocessor.transform(data)[self.feature_columns]
        inflation_features = pd.DataFrame(
            {"const": 1.0}, index=features.index
        )
        predictions = self.result.predict(
            exog=features,
            exog_infl=inflation_features,
            which="mean",
        )
        return pd.Series(predictions, index=data.index, name=self.target)


@dataclass(frozen=True)
class FeaturePreprocessor:
    """Training-fitted imputation, feature selection, and scaling parameters."""

    columns: list[str]
    medians: pd.Series
    means: pd.Series
    scales: pd.Series

    @classmethod
    def fit(cls, data: pd.DataFrame) -> "FeaturePreprocessor":
        raw_features = data[list(PREDICTORS)].astype(float)
        medians = raw_features.median()
        imputed = raw_features.fillna(medians).fillna(0.0)
        scales = imputed.std(ddof=0)
        columns = list(scales[scales.gt(0)].index)
        means = imputed[columns].mean()
        scales = scales[columns].replace(0, 1.0)
        return cls(columns, medians, means, scales)

    def transform(self, data: pd.DataFrame) -> pd.DataFrame:
        raw_features = data[self.columns].astype(float)
        features = raw_features.fillna(self.medians[self.columns]).fillna(0.0)
        features = (features - self.means) / self.scales
        return sm.add_constant(features, has_constant="add")


@dataclass(frozen=True)
class ModelMetrics:
    """Holdout metrics for a fitted count model."""

    name: str
    rows: int
    mean_absolute_error: float
    root_mean_squared_error: float
    observed_zero_rate: float
    predicted_zero_rate: float
    observed_mean: float
    predicted_mean: float


def _database_path(database: Optional[str]) -> str:
    load_dotenv()
    value = database or os.getenv("DB_FILE_NAME")
    if not value:
        raise ValueError(
            "DB_FILE_NAME is not set; provide it in .env or pass database explicitly"
        )
    return value


def load_training_data(
    database: Optional[str] = None, bucket: str = "training"
) -> pd.DataFrame:
    database_path = _database_path(database)
    uri = database_path.startswith("file:")
    with sqlite3.connect(database_path, uri=uri) as connection:
        select_columns = [TARGET, "repo_url", *PREDICTORS]
        sql_columns = ", ".join(f'"samples"."{name}"' for name in select_columns)
        query = (
            f"SELECT {sql_columns} "
            'FROM "samples" '
            'JOIN "repos" ON "samples"."repo_url" = "repos"."url" '
            'WHERE "repos"."bucket" = ? '
            f'AND "samples"."{TARGET}" IS NOT NULL'
        )
        return pd.read_sql_query(query, connection, params=(bucket,))


def _validate_response(data: pd.DataFrame) -> pd.Series:
    response = data[TARGET].astype(int)
    if response.lt(0).any():
        raise ValueError(f"{TARGET} must contain non-negative counts")
    return response


def train_models(data: pd.DataFrame) -> tuple[TrainedModel, TrainedModel]:
    """Fit zero-inflated Poisson and negative-binomial models."""
    preprocessor = FeaturePreprocessor.fit(data)
    features = preprocessor.transform(data)
    response = _validate_response(data)
    feature_columns = list(features.columns)
    if len(response) <= 2 * len(feature_columns):
        features = features[["const"]]
        feature_columns = ["const"]
    inflation_features = pd.DataFrame({"const": 1.0}, index=data.index)

    poisson = ZeroInflatedPoisson(
        response, features, exog_infl=inflation_features, inflation="logit"
    ).fit(method="bfgs", maxiter=1000, disp=False)
    negative_binomial = ZeroInflatedNegativeBinomialP(
        response, features, exog_infl=inflation_features, inflation="logit"
    ).fit(method="bfgs", maxiter=1000, disp=False)
    return (
        TrainedModel(
            "zero_inflated_poisson",
            TARGET,
            feature_columns,
            len(response),
            poisson,
            preprocessor,
        ),
        TrainedModel(
            "zero_inflated_negative_binomial",
            TARGET,
            feature_columns,
            len(response),
            negative_binomial,
            preprocessor,
        ),
    )


def validate_models(
    models: Sequence[TrainedModel], data: pd.DataFrame
) -> list[ModelMetrics]:
    """Evaluate fitted models on a separate, untouched dataset."""
    response = _validate_response(data)
    metrics = []
    for model in models:
        predictions = model.predict(data).clip(lower=0.0)
        metrics.append(
            ModelMetrics(
                name=model.name,
                rows=len(data),
                mean_absolute_error=float((response - predictions).abs().mean()),
                root_mean_squared_error=float(
                    ((response - predictions).pow(2).mean()) ** 0.5
                ),
                observed_zero_rate=float(response.eq(0).mean()),
                predicted_zero_rate=float(predictions.lt(0.5).mean()),
                observed_mean=float(response.mean()),
                predicted_mean=float(predictions.mean()),
            )
        )
    return metrics


def main(argv: Optional[Sequence[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", help="SQLite path or URI (defaults to DB_FILE_NAME)")
    parser.add_argument(
        "--validation-bucket",
        default="validation",
        help="Repository bucket used for holdout metrics (default: validation)",
    )
    args = parser.parse_args(argv)

    models = train_models(load_training_data(database=args.database, bucket="training"))
    for model in models:
        print(f"{model.name}: {model.rows} rows, target={model.target}")
        print(model.result.summary())
    validation_data = load_training_data(
        database=args.database, bucket=args.validation_bucket
    )
    for metric in validate_models(models, validation_data):
        print(
            f"{metric.name} validation: rows={metric.rows}, "
            f"mae={metric.mean_absolute_error:.3f}, "
            f"rmse={metric.root_mean_squared_error:.3f}, "
            f"observed_mean={metric.observed_mean:.3f}, "
            f"predicted_mean={metric.predicted_mean:.3f}, "
            f"observed_zero_rate={metric.observed_zero_rate:.3f}, "
            f"predicted_zero_rate={metric.predicted_zero_rate:.3f}"
        )


if __name__ == "__main__":
    main()
