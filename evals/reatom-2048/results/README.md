# Published run snapshots

This directory is where published run snapshots go.

Do not copy a workspace wholesale. `starter/.gitignore` hides `.run` and `.pi`, and `.pi/baton/.gitignore` hides status files, so a plain directory copy drops the records a snapshot needs.

Copy the solution `src/`, `.run/status.json`, `.run/grade.json`, and the Baton `summary.json` (`.pi/baton/sessions/<id>/summary.json`). Omit `node_modules`, `dist`, `.git`, and the nested gitignore files.

Do not copy any real logs or secrets into `results/`.
