export function clipboardImageFiles(
  clipboard: Pick<DataTransfer, "files" | "items">,
): File[] {
  const fromItems = Array.from(clipboard.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return fromItems.length > 0
    ? fromItems
    : Array.from(clipboard.files).filter((file) =>
        file.type.startsWith("image/"),
      );
}
