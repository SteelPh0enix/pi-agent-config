---
description: Review a module/file and plan a refactor to clean it up and simplify it.
argument-hint: "<path-to-module-or-file> [additional comments]"
---
You are tasked with reviewing a following file/module: $1
Perform a review focusing on simplifying the code, removing redundant and repeating parts, and cleaning up any unused parts of the file/module.
Look up the files/modules using the one you're currently refactoring, to make sure you apply the external changes everywhere in the codebase.
After performing the review, write up a refactor plan and wait for user's comments and confirmation before implementing it.
${@:2}
