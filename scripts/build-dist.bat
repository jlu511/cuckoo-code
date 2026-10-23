@echo off
chcp 65001 >nul
setlocal
title Cuckoo Code - Build to dist

cd /d "%~dp0.."
set "PROJECT_DIR=%CD%"
set "LOG=%TEMP%\cc-build-dist.log"
set "ASAR_MAX_MB=450"

echo ============================================
echo   Cuckoo Code - Full Build
echo   Project: %PROJECT_DIR%
echo   Output : %PROJECT_DIR%\dist
echo ============================================
echo.

REM ---------- 1. Kill Cuckoo (avoid app.asar lock) ----------
echo [1/6] Closing Cuckoo-Code processes...
taskkill /F /IM Cuckoo-Code.exe /T >nul 2>&1
timeout /t 3 /nobreak >nul

tasklist /FI "IMAGENAME eq Cuckoo-Code.exe" 2>nul | find /I "Cuckoo-Code.exe" >nul
if not errorlevel 1 (
    echo [ERROR] Cuckoo-Code.exe is still running.
    echo         Please quit it from the tray icon, then retry.
    pause
    exit /b 1
)
echo        Done.

REM ---------- 2. Remove dist ----------
echo [2/6] Removing dist...
if exist "dist" rmdir /s /q "dist" 2>nul
if exist "dist\." (
    echo [ERROR] Cannot remove dist - files are locked.
    echo         Close any program using dist files, then retry.
    pause
    exit /b 1
)
echo        Done.

REM ---------- 3. Remove dist-* leftovers (abort on failure) ----------
echo [3/6] Removing dist-* leftovers...
set FOUND_RESIDUE=0
for /d %%D in (dist-*) do (
    set FOUND_RESIDUE=1
    echo        Removing %%D ...
    rmdir /s /q "%%D" 2>nul
    if exist "%%D\." (
        echo [ERROR] Cannot remove leftover directory: %%D
        echo         Aborting build to prevent it from being packed into ASAR.
        pause
        exit /b 1
    )
)
if %FOUND_RESIDUE%==0 echo        Nothing to remove.
echo        Done.

REM ---------- 4. Compile ----------
echo [4/6] Compiling...
call npm run compile > "%LOG%" 2>&1
if errorlevel 1 (
    echo [ERROR] Compile failed. Log tail:
    powershell -NoProfile -Command "Get-Content '%LOG%' -Tail 30"
    pause
    exit /b 1
)
echo        Compile OK.

REM ---------- 5. Package ----------
echo [5/6] Packaging (electron-builder, 5-15 min)...
echo. >> "%LOG%"
echo === electron-builder === >> "%LOG%"
call npx electron-builder --win --publish never --config.electronDist=node_modules/electron/dist >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo [ERROR] Packaging failed, exitCode=%RC%. Log tail:
    powershell -NoProfile -Command "Get-Content '%LOG%' -Tail 40"
    pause
    exit /b %RC%
)
echo        Package OK.

REM ---------- 6. Verify artifacts ----------
echo [6/6] Verifying artifacts...
if not exist "dist\win-unpacked\resources\app.asar" (
    echo [ERROR] app.asar not found.
    pause
    exit /b 1
)
if not exist "dist\cuckoo-code-win-v0.8.17.exe" (
    echo [ERROR] Installer not found.
    pause
    exit /b 1
)

REM 6a. Hard size limit
powershell -NoProfile -Command "$max=[int64]%ASAR_MAX_MB% * 1MB; $a=(Get-Item 'dist\win-unpacked\resources\app.asar').Length; $mb=[math]::Round($a/1MB,1); Write-Host ('      ASAR = ' + $mb + ' MB / limit %ASAR_MAX_MB% MB'); if ($a -gt $max) { Write-Host '[ERROR] app.asar exceeds size limit - unwanted dirs may be packed.' -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
    pause
    exit /b 1
)

REM 6b. List ASAR root entries and reject forbidden dirs
echo.
echo       ASAR root entries:
node -e "const asar=require('@electron/asar');const p='dist/win-unpacked/resources/app.asar';const l=asar.listPackage(p);const r={};for(const f of l){const s=f.replace(/^[\\/]/,'').split(/[\\/]/)[0];r[s]=(r[s]||0)+1;}const keys=Object.keys(r).sort();for(const k of keys)console.log('         ' + k + ' = ' + r[k]);const FORBIDDEN=['1','reference','update','dist'];const bad=keys.filter(k=>{const lo=k.toLowerCase();return /^dist-/.test(lo)||FORBIDDEN.includes(lo);});if(bad.length){console.log('[ERROR] ASAR contains forbidden dirs: ' + bad.join(','));process.exit(1);}"
if errorlevel 1 (
    echo [ERROR] ASAR content check failed.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   BUILD SUCCESS
echo ============================================
powershell -NoProfile -Command "Get-Item 'dist\win-unpacked\resources\app.asar' | ForEach-Object { 'ASAR  ' + [math]::Round($_.Length/1MB,1) + ' MB  ' + $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') }; Get-Item 'dist\cuckoo-code-win-v0.8.17.exe' | ForEach-Object { 'EXE   ' + [math]::Round($_.Length/1MB,1) + ' MB  ' + $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') }"
echo.
echo Installer: %PROJECT_DIR%\dist\cuckoo-code-win-v0.8.17.exe
echo Log      : %LOG%
echo.
echo Press any key to close...
pause >nul