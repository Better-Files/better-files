# Architecture decision records

Each record states one decision that shapes Better Files: the context, the decision, and its consequences. Each record
also has a dated **Status of the implementation** section, which lists where the code still differs from the decision
or from [PLAN.md](../../PLAN.md). Update that section when the gap closes. Do not rewrite the decision itself.

| ADR                                               | Decision                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [001](0001-two-layer-authorization.md)            | Every operation passes the engine's capability matrix **and** the identity system's policy        |
| [002](0002-own-tables-and-consistency.md)         | Better Files owns its tables; IAM is authoritative for membership; cross-store writes fail closed |
| [003](0003-schema-model-and-code-generation.md)   | One declarative schema model drives types, adapters and generated SQL/Prisma/Drizzle              |
| [004](0004-crypto-format.md)                      | Segmented AES-256-GCM (STREAM) per blob, with DEKs wrapped per room through a `KeyProvider`       |
| [005](0005-plugin-contract-and-type-inference.md) | Plugins are plain objects; `dr.api` and the client infer plugin endpoints with no codegen         |

## Writing a new record

- Copy the shape of an existing record: title, status, date, plan reference, then **Context**, **Decision**,
  **Consequences** and **Status of the implementation**.
- Number records in order, `NNNN-short-title.md`, and add a row to the table above.
- Point to code by path and symbol name, not by line number. Line numbers change too often.
- To reverse a decision, write a new record and mark the old one **Superseded by ADR-NNN**. Do not delete the old
  record.
