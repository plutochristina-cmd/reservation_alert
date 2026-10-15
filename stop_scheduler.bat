@echo off
chcp 65001 > nul
echo [네이버 예약 알리미] 백그라운드 스케줄러 프로세스를 종료합니다...
powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*scheduler.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('[종료됨] PID: ' + $_.ProcessId) }"
echo 완료되었습니다.
pause
