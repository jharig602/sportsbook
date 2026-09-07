@echo off
REM Node was installed during this session, so the parent process's PATH predates it.
REM Prepend the install directory explicitly rather than relying on a shell restart.
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0web"
npm run dev
