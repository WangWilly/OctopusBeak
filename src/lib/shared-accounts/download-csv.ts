/** Save `csv` through the browser's download flow under a filesystem-safe name. */
export function downloadCsv(name: string, csv: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `${name.replaceAll(/[\\/:*?"<>|]/gu, "-")}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
