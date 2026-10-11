; OFM 安装器自定义钩子
; 安装前后显示终端风格信息

!macro NSIS_HOOK_PREINSTALL
  ; 安装前：清理旧进程
  nsExec::ExecToStack 'taskkill /F /IM ofm-desktop.exe 2>nul'
  Pop $0
  Pop $1
  
  ; 清理锁文件
  Delete "$PROFILE\.our-free-model\service.lock"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 安装后：创建数据目录
  CreateDirectory "$PROFILE\.our-free-model"
  
  ; 写入初始配置（如果不存在）
  IfFileExists "$PROFILE\.our-free-model\settings.json" +4
    FileOpen $0 "$PROFILE\.our-free-model\settings.json" w
    FileWrite $0 '{}'
    FileClose $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载前：停止服务和桌面应用
  nsExec::ExecToStack 'taskkill /F /IM ofm-desktop.exe 2>nul'
  Pop $0
  Pop $1
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载后：清理残留
  Delete "$PROFILE\.our-free-model\service.lock"
!macroend