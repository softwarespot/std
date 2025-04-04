// Copyright 2018-2025 the Deno authors. MIT license.
// This module is browser compatible.

/** Options for providing formatting marks. */
export interface FormattingOptions {
  /**
   * Character(s) used to break lines in the config file. Ignored on parse.
   *
   * @default {"\n"}
   */
  lineBreak?: "\n" | "\r\n" | "\r";
  /**
   * Use a plain assignment char or pad with spaces. Ignored on parse.
   *
   * @default {false}
   */
  pretty?: boolean;
}

/** Possible INI value types. */
type IniValue =
  | string
  | number
  | boolean
  | null
  | undefined;

/** Represents an INI section. */
type IniSection = Record<string, IniValue>;

/** Options for parsing INI strings. */
interface ParseOptions {
  /** Provide custom parsing of the value in a key/value pair. */
  reviver?: ReviverFunction;
}

/** Function for replacing JavaScript values with INI string values. */
export type ReplacerFunction = (
  key: string,
  // deno-lint-ignore no-explicit-any
  value: any,
  section?: string,
) => string;

/** Function for replacing INI values with JavaScript values. */
export type ReviverFunction = (
  key: string,
  value: string,
  section?: string,
) => unknown;

const ASSIGNMENT_MARK = "=";

function isPlainObject(object: unknown): object is object {
  return Object.prototype.toString.call(object) === "[object Object]";
}

function trimQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

const NON_WHITESPACE_REGEXP = /\S/;

/**
 * Class implementation for fine control of INI data structures.
 */
export class IniMap {
  #global = new Map<string, LineValue>();
  #sections = new Map<string, LineSection>();
  #lines: Line[] = [];
  #formatting: FormattingOptions;

  /** Constructs a new `IniMap`.
   *
   * @param formatting Optional formatting options when printing an INI file.
   */
  constructor(formatting: FormattingOptions = {}) {
    this.#formatting = formatting;
  }

  /**
   * Set the value of a global key in the INI.
   *
   * @param key The key to set the value
   * @param value The value to set
   * @returns The map object itself
   */
  set(key: string, value: IniValue): this;
  /**
   * Set the value of a section key in the INI.
   *
   * @param section The section
   * @param key The key to set
   * @param value The value to set
   * @return The map object itself
   */
  set(section: string, key: string, value: IniValue): this;
  set(
    keyOrSection: string,
    valueOrKey: string | IniValue,
    value?: IniValue,
  ): this {
    if (typeof valueOrKey === "string" && value !== undefined) {
      const section = this.#getOrCreateSection(keyOrSection);
      const exists = section.map.get(valueOrKey);

      if (exists) {
        exists.val = value;
      } else {
        section.end += 1;
        const lineValue: LineValue = {
          type: "value",
          num: section.end,
          sec: section.sec,
          key: valueOrKey,
          val: value,
        };
        this.#appendValue(lineValue);
        section.map.set(valueOrKey, lineValue);
      }
    } else {
      const lineValue: LineValue = {
        type: "value",
        num: 0, // Simply set to zero since we have to find the end ofthe global keys
        key: keyOrSection,
        val: valueOrKey,
      };
      this.#appendValue(lineValue);
      this.#global.set(keyOrSection, lineValue);
    }

    return this;
  }

  #getOrCreateSection(section: string): LineSection {
    const existing = this.#sections.get(section);

    if (existing) {
      return existing;
    }

    const lineSection: LineSection = {
      type: "section",
      num: this.#lines.length + 1,
      sec: section,
      map: new Map<string, LineValue>(),
      end: this.#lines.length + 1,
    };
    this.#lines.push(lineSection);
    this.#sections.set(section, lineSection);
    return lineSection;
  }

  #appendValue(lineValue: LineValue): void {
    if (this.#lines.length === 0) {
      // For an empty array, just insert the line value
      lineValue.num = 1;
      this.#lines.push(lineValue);
    } else if (lineValue.sec) {
      // For line values in a section, the end of the section is known
      this.#appendOrDeleteLine(lineValue, LineOp.Add);
    } else {
      // For global values, find the line preceding the first section
      lineValue.num = this.#lines.length + 1;
      for (const [i, line] of this.#lines.entries()) {
        if (line.type === "section") {
          lineValue.num = i + 1;
          break;
        }
      }
      // Append the line value at the end of all global values
      this.#appendOrDeleteLine(lineValue, LineOp.Add);
    }
  }

  #appendOrDeleteLine(input: Line, op: LineOp) {
    if (op === LineOp.Add) {
      this.#lines.splice(input.num - 1, 0, input);
    } else {
      this.#lines.splice(input.num - 1, 1);
    }
    // If the input is a comment, find the next section if any to update.
    let updateSection = input.type === "comment";
    const start = op === LineOp.Add ? input.num : input.num - 1;
    for (const line of this.#lines.slice(start)) {
      line.num += op;
      if (line.type === "section") {
        line.end += op;
        // If the comment is before the nearest section, don't update the section further.
        updateSection = false;
      }
      if (updateSection) {
        // if the comment precedes a value in a section, get and update the section end.
        if (line.type === "value" && line.sec) {
          const section = this.#sections.get(line.sec);

          if (section) {
            section.end += op;
            updateSection = false;
          }
        }
      }
    }
  }

  *#readTextLines(text: string): Generator<string> {
    const { length } = text;
    let line = "";

    for (let i = 0; i < length; i += 1) {
      const char = text[i]!;

      if (char === "\n" || char === "\r") {
        yield line;
        line = "";
        if (char === "\r" && text[i + 1] === "\n") {
          i++;
          if (!this.#formatting.lineBreak) {
            this.#formatting.lineBreak = "\r\n";
          }
        } else if (!this.#formatting.lineBreak) {
          this.#formatting.lineBreak = char;
        }
      } else {
        line += char;
      }
    }

    yield line;
  }

  /**
   * Convert this `IniMap` to a plain object.
   *
   * @returns The object equivalent to this {@code IniMap}
   */
  toObject<T extends object>(): T {
    const obj: T = {} as T;

    for (const { key, val } of this.#global.values()) {
      Object.defineProperty(obj, key, {
        value: val,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    for (const { sec, map } of this.#sections.values()) {
      const section: IniSection = {};
      Object.defineProperty(obj, sec, {
        value: section,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      for (const { key, val } of map.values()) {
        Object.defineProperty(section, key, {
          value: val,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }

    return obj;
  }

  /**
   * Parse an INI string in this `IniMap`.
   *
   * @param text The text to parse
   * @param reviver The reviver function
   * @returns This {@code IniMap} object
   */
  parse(text: string, reviver?: ReviverFunction): this {
    if (typeof text !== "string") {
      throw new SyntaxError(`Unexpected token ${text} in INI at line 0`);
    }

    reviver ??= (_key, value, _section) => {
      if (!isNaN(+value) && !value.includes('"')) return +value;
      if (value === "null") return null;
      if (value === "true" || value === "false") return value === "true";
      return trimQuotes(value);
    };

    let lineNumber = 1;
    let currentSection: LineSection | undefined;

    for (const line of this.#readTextLines(text)) {
      const trimmed = line.trim();
      if (isComment(trimmed)) {
        this.#lines.push({
          type: "comment",
          num: lineNumber,
          val: trimmed,
        });
      } else if (isSection(trimmed, lineNumber)) {
        const sec = trimmed.substring(1, trimmed.length - 1);

        if (!NON_WHITESPACE_REGEXP.test(sec)) {
          throw new SyntaxError(
            `Unexpected empty section name at line ${lineNumber}`,
          );
        }

        currentSection = {
          type: "section",
          num: lineNumber,
          sec,
          map: new Map<string, LineValue>(),
          end: lineNumber,
        };
        this.#lines.push(currentSection);
        this.#sections.set(currentSection.sec, currentSection);
      } else {
        const assignmentPos = trimmed.indexOf(ASSIGNMENT_MARK);

        if (assignmentPos === -1) {
          throw new SyntaxError(
            `Unexpected token ${trimmed[0]} in INI at line ${lineNumber}`,
          );
        }
        if (assignmentPos === 0) {
          throw new SyntaxError(
            `Unexpected empty key name at line ${lineNumber}`,
          );
        }

        const leftHand = trimmed.substring(0, assignmentPos);
        const rightHand = trimmed.substring(assignmentPos + 1);

        if (this.#formatting.pretty === undefined) {
          this.#formatting.pretty = leftHand.endsWith(" ") &&
            rightHand.startsWith(" ");
        }

        const key = leftHand.trim();
        const value = rightHand.trim();

        if (currentSection) {
          const lineValue: LineValue = {
            type: "value",
            num: lineNumber,
            sec: currentSection.sec,
            key,
            val: reviver(key, value, currentSection.sec),
          };
          currentSection.map.set(key, lineValue);
          this.#lines.push(lineValue);
          currentSection.end = lineNumber;
        } else {
          const lineValue: LineValue = {
            type: "value",
            num: lineNumber,
            key,
            val: reviver(key, value),
          };
          this.#global.set(key, lineValue);
          this.#lines.push(lineValue);
        }
      }

      lineNumber += 1;
    }

    return this;
  }

  /**
   * Create an `IniMap` from an INI string.
   *
   * @param input The input string
   * @param options The options to use
   * @returns The parsed {@code IniMap}
   */
  static from(
    input: string,
    options?: ParseOptions & FormattingOptions,
  ): IniMap;
  /**
   * Create an `IniMap` from a plain object.
   *
   * @param input The input string
   * @param formatting The options to use
   * @returns The parsed {@code IniMap}
   */
  static from(input: object, formatting?: FormattingOptions): IniMap;
  static from(
    input: string | object,
    formatting?: ParseOptions & FormattingOptions,
  ): IniMap {
    const ini = new IniMap(formatting);
    if (typeof input === "object" && input !== null) {
      const sort = (
        [_a, valA]: [string, unknown],
        [_b, valB]: [string, unknown],
      ) => {
        if (isPlainObject(valA)) return 1;
        if (isPlainObject(valB)) return -1;
        return 0;
      };

      for (const [key, val] of Object.entries(input).sort(sort)) {
        if (isPlainObject(val)) {
          for (const [sectionKey, sectionValue] of Object.entries(val)) {
            ini.set(key, sectionKey, sectionValue);
          }
        } else {
          ini.set(key, val);
        }
      }
    } else {
      ini.parse(input, formatting?.reviver);
    }
    return ini;
  }
}

/** Detect supported comment styles. */
function isComment(input: string): boolean {
  return input === "" ||
    input.startsWith("#") ||
    input.startsWith(";") ||
    input.startsWith("//");
}

/** Detect a section start. */
function isSection(input: string, lineNumber: number): boolean {
  if (input.startsWith("[")) {
    if (input.endsWith("]")) {
      return true;
    }
    throw new SyntaxError(
      `Unexpected end of INI section at line ${lineNumber}`,
    );
  }
  return false;
}

type LineOp = typeof LineOp[keyof typeof LineOp];
const LineOp = {
  Del: -1,
  Add: 1,
} as const;

interface LineComment {
  type: "comment";
  num: number;
  val: string;
}

interface LineSection {
  type: "section";
  num: number;
  sec: string;
  map: Map<string, LineValue>;
  end: number;
}

interface LineValue {
  type: "value";
  num: number;
  sec?: string;
  key: string;
  val: unknown;
}

type Line = LineComment | LineSection | LineValue;
