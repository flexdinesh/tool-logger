import { Fragment } from "react";

export function MetadataFields({ values }: { values: [string, string][] }) {
  return values.map(([label, value]) => (
    <Fragment key={label}><dt className="text-muted">{label}</dt><dd className="m-0 wrap-anywhere font-mono text-xs text-secondary">{value}</dd></Fragment>
  ));
}
