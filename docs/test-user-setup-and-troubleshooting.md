# TEXOR Test User Setup And Troubleshooting

This guide is for early test users installing TEXOR from the VSCode Marketplace or a VSIX package.

## What TEXOR Installs

TEXOR installs only the VSCode extension and its local browser workbench.
It does not install Node.js, VSCode, LaTeX, Codex, or Python.

Users should prepare:

- VSCode.
- A working LaTeX distribution with `pdflatex` or `lualatex` on `PATH`.
- Codex CLI, available as `codex` from a normal terminal.
- Internet access if using a journal template for the first time.

## Template Source

The extension package contains only `templates/catalog.json`, not the full template archives.
When a user selects a supported journal or conference template for the first time, TEXOR downloads the official archive into the extension data cache.

Current direct-download sources:

- IEEEtran / IEEE article / IEEE TIM: `https://mirrors.ctan.org/macros/latex/contrib/IEEEtran.zip`
- ACM acmart: `https://mirrors.ctan.org/macros/latex/contrib/acmart.zip`
- Elsevier elsarticle: `https://mirrors.ctan.org/macros/latex/contrib/elsarticle.zip`
- Elsevier CAS: `https://mirrors.ctan.org/macros/latex/contrib/els-cas-templates.zip`
- ICLR 2026: `https://github.com/ICLR/Master-Template/raw/master/iclr2026.zip`

If a catalog entry has no direct archive URL, TEXOR shows that manual download is required.
On Windows, TEXOR uses PowerShell `Expand-Archive` to unpack templates.
On macOS/Linux, TEXOR uses `unzip`.

## Project Actions

The sidebar separates project records from manuscript import:

- `加载项目`: open an existing TEXOR project record, keeping the same code project, Codex conversation, manuscript versions, feedback, and history.
- `新建项目`: create a new TEXOR project record for a code project path.
- `导入当前项目 .tex`: import an existing manuscript into the current project only. TEXOR copies that file into `<project>/.texor/manuscript/main.tex`, and all later revisions use this `main.tex` as the manuscript entrypoint.

The code project path is always required. Codex uses it to understand the research project, run experiments, and update figures or tables.
The `.tex` path is optional. It is only an initial manuscript source.

## Windows LaTeX Error

Old builds could fail on Windows with an error like:

```text
PDF 编译失败，已显示源码差异：! Undefined control sequence.
<*> ..\builds \build-...\ .texor\manuscript\main.tex
```

Cause: TeX interpreted backslashes in Windows paths as LaTeX commands.

Fix: use TEXOR `0.1.3` or newer. TEXOR now passes forward-slash paths to LaTeX.

If the error remains after upgrading, check that `pdflatex --version` works in a normal terminal and that the manuscript itself compiles outside TEXOR.

## Codex `spawn EFTYPE` On Windows

Old builds could show:

```text
启动 Codex CLI: C:\Users\...\npm\codex.ps1
spawn EFTYPE
```

Cause: Node cannot directly spawn a PowerShell `.ps1` shim as an executable.

Fix: use TEXOR `0.1.3` or newer. TEXOR now prefers `codex.cmd` when available, and falls back to `powershell.exe -File codex.ps1`.

Manual workaround for old builds:

1. Open VSCode Settings.
2. Search `texor.codexExecutable`.
3. Set it to the full path of `codex.cmd` or `codex.exe`, not `codex.ps1`.
4. Confirm in PowerShell:

```powershell
where.exe codex
codex --version
```

If `where.exe codex` prints nothing, Codex CLI is not on `PATH`.

## Minimal Windows Environment Check

Run these in PowerShell:

```powershell
code --version
node --version
npm --version
pdflatex --version
codex --version
where.exe codex
```

Expected:

- `pdflatex --version` or `lualatex --version` must succeed.
- `codex --version` must succeed.
- `where.exe codex` should ideally include `codex.cmd` or `codex.exe`.

