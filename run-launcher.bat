@echo off
setlocal
pushd %~dp0
powershell -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
popd