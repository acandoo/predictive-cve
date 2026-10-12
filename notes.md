Four models:

- number of CVEs _reported_ for a codebase some time T after a repository state
- number of CVEs _introduced_ to a codebase some time T after a repository state
- cumulative CVSS score _reported_ for a codebase some time T after a repository state
- cumulative CVSS score _introduced_ to a codebase some time T after a repository state

zero inflated dataset; most repos dont have cves.

no features based on existing cves so model could be generalized to repos not using the cve system

Common features:

- OpenSSF scorecard submetrics
- CHAOSS [starter project health metrics model](https://www.chaoss.community/kb/metrics-model-starter-project-health/)
- misc. git repo heuristics not covered by OpenSSF/CHAOSS

the OpenSSF scorecard, which covers repository best practices and security/CI infrastructure; CHAOSS metrics on project health, which cover contributor dynamics; and my own existing research into matching raw repository heuristics to manual labeling via clustering.

Sampling repository multiple times?

openssf scorecard metrics:

entirely commit dependent:

- Binary-Artifacts
- Dangerous-Workflow
- Dependency-Update-Tool
- License
- Pinned-Dependencies
- Permissions
- Security-Policy

others cannot entirely track historically
