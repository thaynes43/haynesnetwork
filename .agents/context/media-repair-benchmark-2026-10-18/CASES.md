# Frozen case index

Evaluator-only; never send this index to a model. Every row is a historical
documentary confirmation, not a freshly decoded-media adjudication. The linked
source supports the observation, including matched controls.

| ID | Family | Split | Label | Expected | Observation source |
| --- | --- | --- | --- | --- | --- |
| c01 | city | development | mismatch | City of Illusions | [City of Illusions](https://github.com/thaynes43/haynesnetwork/blob/ff789924f0402bc67896c24c3f1b8bf462118eb8/.agents/context/ll-library-audit/fix_census_795.py#L25-L27) |
| c02 | city | development | match | City of Illusions | [City of Illusions](https://github.com/thaynes43/haynesnetwork/blob/ff789924f0402bc67896c24c3f1b8bf462118eb8/.agents/context/ll-library-audit/fix_census_795.py#L25-L27) |
| c03 | crown | development | mismatch | A Crown of Swords | [A Crown of Swords](https://github.com/thaynes43/haynesnetwork/blob/ff789924f0402bc67896c24c3f1b8bf462118eb8/.agents/context/ll-library-audit/fix_census_795.py#L19-L24) |
| c04 | crown | development | match | A Crown of Swords | [A Crown of Swords](https://github.com/thaynes43/haynesnetwork/blob/ff789924f0402bc67896c24c3f1b8bf462118eb8/.agents/context/ll-library-audit/fix_census_795.py#L19-L24) |
| c05 | zom | development | mismatch | Zom 100: Bucket List of the Dead | [The Convert](https://github.com/thaynes43/haynesnetwork/issues/940) |
| c06 | zom | development | match | Zom 100: Bucket List of the Dead | [Zom 100: Bucket List of the Dead](https://github.com/thaynes43/haynesnetwork/issues/940) |
| c07 | anne | held_out | mismatch | Anne of Green Gables | [Anne of Green Gables](https://github.com/thaynes43/haynesnetwork/blob/ff789924f0402bc67896c24c3f1b8bf462118eb8/.agents/context/ll-library-audit/fix_census_795.py#L38-L40) |
| c08 | anne | held_out | match | Anne of Green Gables | [Anne of Green Gables](https://github.com/thaynes43/haynesnetwork/blob/ff789924f0402bc67896c24c3f1b8bf462118eb8/.agents/context/ll-library-audit/fix_census_795.py#L38-L40) |
| c09 | spidey | held_out | mismatch | Spidey and His Amazing Friends | [Spidey and His Amazing Friends](https://github.com/thaynes43/haynesnetwork/issues/928#issuecomment-6149686202) |
| c10 | spidey | held_out | match | Spidey and His Amazing Friends | [Spidey and His Amazing Friends](https://github.com/thaynes43/haynesnetwork/issues/928#issuecomment-6149686202) |
| c11 | moana-alias | development | match | Moana | [Vaiana](https://github.com/thaynes43/haynesnetwork/issues/940) |

For Spidey c09 the desired target is the E03/E04 two-segment broadcast; the historical
wrong file was assigned to E03 only. The reference candidate is historical file72095
with E03/E04 subtitle openings. c10 is file64846 on its correct E01/E02 broadcast.
Native episode mappings are not changed by the evidence-fixture repair.
