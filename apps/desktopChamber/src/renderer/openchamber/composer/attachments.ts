export function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function hasFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  return (
    (data.files?.length ?? 0) > 0 ||
    Array.from(data.types ?? []).some((type) => type.toLowerCase() === "files")
  );
}
