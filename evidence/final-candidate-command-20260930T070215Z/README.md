# Final-candidate command-session regression

This evidence folder records serial real-Electron observations against the built delivery worktree. The original rehearsal observations and formal-command defect observation used `fix/6-mvp-delivery` at `e3ea343dd0c3d88dbbc47ce82e58351fbc44d35c`. The separate post-fix formal-quit-only retest used `fix/6-mvp-delivery` at `f90e798aa24e1726ea615f1b6f8d98c2afde4434`. Both delivery worktrees were clean during their respective runs. `prepared.json` now records the f90e798 source hashes, compiled-output hashes, Electron executable hash, and the independent build-provenance limitation; the prior e3ea343 snapshot is retained as `prepared-e3ea343-original.json`. No product source or compiled output was changed by the GUI runs.

The GUI runner uses the existing Playwright Core installation from the readiness worktree. Each scenario gets fresh `APPDATA`, `LOCALAPPDATA`, `TEMP`, user data, and `GH_CONFIG_DIR`; `GH_TOKEN` and `GITHUB_TOKEN` are removed. The runner records actual process identities and parent chains, archives each temporary root wrapper into its profile, and records cleanup readbacks. The serial GUI window was owner-authorized and is now returned.

`--prepare-only` refreshes `prepared.json` without launching Electron. Real runs require `--serial-window-authorized`. The scenario-selection flags run only the named subset; `--results-out` preserves other result files. For example:

```powershell
node .\final-candidate-command.mjs --serial-window-authorized --rehearsals-only
node .\final-candidate-command.mjs --serial-window-authorized --formal-quit-only --results-out results-formal-quit.json
```

## Result index

- `results-attempt-1-harness-error.json` preserves the first seven-scenario run. All scenarios stopped at a harness property-name error before their product assertions; it is not candidate evidence.
- `results-first-probe-only.json` records the first scenario passing after that harness fix and confirms the runner reached the built UI.
- `results-attempt-2-short-rehearsal-window.json` preserves the next seven-scenario run. The first five scenarios passed. Both rehearsal cases expired their five-second fixture before the initial process-identity query completed.
- `results-attempt-3-preview-modal-timeout.json` preserves the rehearsal-only retry with a longer fixture. It exposed a second harness mismatch: the helper waited for the confirmation dialog while the preview rehearsal was still running.
- `results-rehearsals-final.json` records the final two rehearsal observations. Leaving the page and quitting during rehearsal both passed; each action began 10,008 ms after its start marker, before the 20-second fixture deadline. Neither formal command sentinel appeared. The relevant rehearsal PIDs and Electron/Playwright PIDs were absent on readback.
- `results.json` is byte-identical to `results-rehearsals-final.json` and remains the default runner output.
- `results-formal-quit.json` records a supplementary formal-command quit observation. The Electron main and direct command PIDs were absent after app quit, but the command's PowerShell descendant remained alive before cleanup. Both completion sentinels were absent. The cleanup readback verified the descendant identity, terminated it by PID/tree, and confirmed it absent. This is the observed candidate defect being handled separately; the result does not report acceptance.
- `results-formal-quit-f90e798.json` records the single post-fix formal-command quit retest. Main, command, and child PIDs were live before quit and absent after app quit before cleanup; neither completion sentinel appeared. `runner-formal-quit-f90e798.txt` is the isolated console log, and `manifest-formal-quit-f90e798.json` records delivery/build hashes, independent PID readbacks, wrapper archival, and preservation of the original FAIL result.
- `runner-final-evidence.txt` is the saved, line-by-line runner log for all attempts.

The formal-command quit scenario was added after the initial preparation snapshot; delivery source and compiled hashes remained unchanged. The evidence distinguishes harness failures from candidate observations. It does not make a Phase Accept, business acceptance, or release decision.
