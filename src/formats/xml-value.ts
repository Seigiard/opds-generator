import * as v from "valibot";

/** Values produced by fast-xml-parser with attributes and numeric text enabled. */
export type XmlValue = string | number | boolean | null | undefined | XmlValue[] | XmlFields;

export interface XmlFields {
  [name: string]: XmlValue;
}

const valueSchema: v.GenericSchema<XmlValue> = v.lazy(() =>
  v.union([v.string(), v.number(), v.boolean(), v.null(), v.undefined(), v.array(valueSchema), v.record(v.string(), valueSchema)]),
);

export const xmlFieldsSchema = v.record(v.string(), valueSchema);

export function xmlFields(value: XmlValue | undefined): XmlFields | undefined {
  // The parser boundary has already validated recursive values. Narrow only this node.
  if (Array.isArray(value) || v.is(scalarSchema, value)) return undefined;

  return value;
}

const scalarSchema = v.union([v.string(), v.number(), v.boolean(), v.null(), v.undefined()]);

export const xmlStringSchema = v.string();

export const xmlNumberSchema = v.number();

export const xmlBooleanSchema = v.boolean();
