/** IPC channels of the "Custom Server…" window (preload.ts ↔ main/serverDialog.ts). */
export const SERVER_DIALOG_IPC = {
  initial: 'narrative-server-dialog:initial',
  submit: 'narrative-server-dialog:submit',
  cancel: 'narrative-server-dialog:cancel',
} as const
