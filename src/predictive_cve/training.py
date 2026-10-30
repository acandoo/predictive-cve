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


def _database_path(database: Optional[str]) -> str:
    load_dotenv()
    value = database or os.getenv("DB_FILE_NAME")
    if not value:
        raise ValueError(
            "DB_FILE_NAME is not set; provide it in .env or pass database explicitly"
        )
    return value


def load_training_data(database: Optional[str] = None) -> pd.DataFrame:
    database_path = _database_path(database)
    uri = database_path.startswith("file:")
    with sqlite3.connect(database_path, uri=uri) as connection:
        select_columns = [TARGET, "repo_url", *PREDICTORS]
        sql_columns = ", ".join(f'"samples"."{name}"' for name in select_columns)
        query = (
            f"SELECT {sql_columns} "
            'FROM "samples" '
            'JOIN "repos" ON "samples"."repo_url" = "repos"."url" '
            'WHERE "repos"."bucket" = \'training\' '
            f'AND "samples"."{TARGET}" IS NOT NULL'
        )
        return pd.read_sql_query(query, connection)


def _prepare_data(data: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, list[str]]:
    response = data[TARGET].astype(int)
    features = data[list(PREDICTORS)].astype(float)
    features = features.fillna(features.median()).fillna(0.0)
    scale = features.std(ddof=0).replace(0, 1)
    features = (features - features.mean()) / scale
    features = sm.add_constant(features, has_constant="add")
    return features, response, list(features.columns)


def train_models(data: pd.DataFrame) -> tuple[TrainedModel, TrainedModel]:
    """Fit zero-inflated Poisson and negative-binomial models."""
    features, response, feature_columns = _prepare_data(data)
    if len(response) <= 2 * len(feature_columns):
        features = features[["const"]]
        feature_columns = ["const"]

    poisson = ZeroInflatedPoisson(
        response, features, exog_infl=features, inflation="logit"
    ).fit(method="bfgs", maxiter=1000, disp=False)
    negative_binomial = ZeroInflatedNegativeBinomialP(
        response, features, exog_infl=features, inflation="logit"
    ).fit(method="bfgs", maxiter=1000, disp=False)
    return (
        TrainedModel("zero_inflated_poisson", TARGET, feature_columns, len(response), poisson),
        TrainedModel(
            "zero_inflated_negative_binomial",
            TARGET,
            feature_columns,
            len(response),
            negative_binomial,
        ),
    )


def main(argv: Optional[Sequence[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", help="SQLite path or URI (defaults to DB_FILE_NAME)")
    args = parser.parse_args(argv)

    models = train_models(load_training_data(database=args.database))
    for model in models:
        print(f"{model.name}: {model.rows} rows, target={model.target}")
        print(model.result.summary())


if __name__ == "__main__":
    main()
