---
description: Plan the described feature, wait for user's review and approval of the plan, and then implement that reviewed plan.
argument-hint: "<feature description>"
---
You are currently in a PLANNING mode. Plan the implementation of the following feature/change in current project:
```text
$@
```
Before planning, scout the codebase to learn it's architecture and be able to correctly generate a plan based on existing code.
If required, use websearch tools to fact-check your ideas.
After you generate the plan, wait for user's review and final approval, and then and ONLY THEN begin implementing the accepted plan.
During (and after finishing) implementation, make sure to run the available linters/formatters over the code.
If you can't infer any linters/formatters and other tools to run on the project from it's documentation, ignore that.
If there are copyright headers in files you edit, update them with current year in copyright range if necessary.
If you add new files, make sure to add copyright headers to them too.
