export function isMobileHost(width: number, native: boolean): boolean {
  return native || width < 768;
}

export function isSoftwareKeyboardVisible(
  viewportHeight: number,
  baselineHeight: number,
  textInputFocused: boolean,
): boolean {
  return textInputFocused && baselineHeight - viewportHeight > 120;
}
