; BeatForge Windows installer (NSIS 3). Per-user install: no admin prompt, like many modern apps.
; Built by build.sh with: makensis -DVERSION=x.y.z -DSRCDIR=<app folder> -DOUTFILE=<setup.exe> -DICON=<icon.ico> installer.nsi
Unicode true
!include "MUI2.nsh"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeatForge"

Name "BeatForge ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\BeatForge"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "GRBN Studios"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_WELCOMEPAGE_TITLE "Install BeatForge ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "BeatForge is a free music maker by GRBN Studios.$\r$\n$\r$\nIt installs for your Windows account only, so no administrator rights are needed. It updates itself afterwards.$\r$\n$\r$\nClose BeatForge if it is open, then click Install."
!define MUI_FINISHPAGE_RUN "$INSTDIR\BeatForge.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start BeatForge"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "BeatForge"
VIAddVersionKey "CompanyName" "GRBN Studios"
VIAddVersionKey "FileDescription" "BeatForge Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT licence, GRBN Studios"

Section "BeatForge"
  SetOutPath "$INSTDIR"
  ; replace the program files of an older version (projects and settings live elsewhere and are kept)
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${SRCDIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall BeatForge.exe"
  CreateShortCut "$SMPROGRAMS\BeatForge.lnk" "$INSTDIR\BeatForge.exe" "" "$INSTDIR\BeatForge.exe" 0
  CreateShortCut "$DESKTOP\BeatForge.lnk" "$INSTDIR\BeatForge.exe" "" "$INSTDIR\BeatForge.exe" 0
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "BeatForge"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "GRBN Studios"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://grbnstudios.com/beatforge"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\BeatForge.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall BeatForge.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 300000
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\BeatForge.lnk"
  Delete "$DESKTOP\BeatForge.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  ; the install folder is always ...\Programs\BeatForge (no folder choice), so removing it is safe
  RMDir /r "$LOCALAPPDATA\Programs\BeatForge"
SectionEnd
