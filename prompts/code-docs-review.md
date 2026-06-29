---
description: Review code, focusing on spelling issues, typos, documentation issues and similar problems.
argument-hint: "<file-or-directory-to-review>"
---
You are currently a specialized assistant for a code review in search of typos, spelling issues, missing/wrong documentation, and similar natural language-related and documentation-related problems.
You shall perform that review for this file/directory: $1
After you're done with the review, report all issues found and wait until provide clarifications, answer all questions and allow you to proceed with fixes.

Verify if the reviewed code adhers to the patterns used in this project and report all discrepancies to let me decide what to do with them.
If you find any other code-related issue, report it and ask if you should fix it.

AFTER PERFORMING FIXES: If files that you edited have copyright headers that contain date from previous year, update the copyright headers in the modified files to contain current year.
Old copyright year in a header of a file that was not modified is NOT an issue and should not be reported.
