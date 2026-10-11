; resources/nsis/protocol.nsh
;
; What the per-user installer registers besides the app (ADR 0014,
; docs/plans/desktop-d0-spec.md §3.5, §3.6), all under HKCU:
;   - narrative://, which brings the sign-in back from the browser;
;   - "Open with Narrative" for .pptx, without taking over the type's
;     default program (no APP_ASSOCIATE: that would break .pptx on uninstall).
; The uninstaller also runs during an update, so it removes the keys only
; on a real uninstall.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\narrative" "" "URL:Narrative"
  WriteRegStr HKCU "Software\Classes\narrative" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\narrative\shell\open\command" "" '"$INSTDIR\Narrative.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\Narrative.Pptx" "" "PowerPoint Presentation"
  WriteRegStr HKCU "Software\Classes\Narrative.Pptx\DefaultIcon" "" '"$INSTDIR\Narrative.exe",0'
  WriteRegStr HKCU "Software\Classes\Narrative.Pptx\shell\open\command" "" '"$INSTDIR\Narrative.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\.pptx\OpenWithProgids" "Narrative.Pptx" ""
  WriteRegStr HKCU "Software\Classes\Applications\Narrative.exe\SupportedTypes" ".pptx" ""
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\narrative"
    DeleteRegKey HKCU "Software\Classes\Narrative.Pptx"
    DeleteRegValue HKCU "Software\Classes\.pptx\OpenWithProgids" "Narrative.Pptx"
    DeleteRegKey HKCU "Software\Classes\Applications\Narrative.exe"
  ${endIf}
!macroend
