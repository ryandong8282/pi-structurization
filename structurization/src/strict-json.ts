export class DuplicateJsonKeyError extends SyntaxError {
  constructor(
    public readonly key: string,
    public readonly offset: number,
  ) {
    super(`Duplicate JSON object key ${JSON.stringify(key)} at offset ${offset}`);
    this.name = "DuplicateJsonKeyError";
  }
}

class DuplicateKeyScanner {
  private offset = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.skipWhitespace();
    this.value();
    this.skipWhitespace();
    if (this.offset !== this.source.length) {
      throw new SyntaxError(`Unexpected token at offset ${this.offset}`);
    }
  }

  private value(): void {
    this.skipWhitespace();
    const token = this.source[this.offset];
    if (token === "{") {
      this.object();
    } else if (token === "[") {
      this.array();
    } else if (token === '"') {
      this.string();
    } else if (token === "t") {
      this.literal("true");
    } else if (token === "f") {
      this.literal("false");
    } else if (token === "n") {
      this.literal("null");
    } else {
      this.number();
    }
  }

  private object(): void {
    this.expect("{");
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.peek("}")) {
      this.offset += 1;
      return;
    }
    while (true) {
      this.skipWhitespace();
      const keyOffset = this.offset;
      const key = this.string();
      if (keys.has(key)) {
        throw new DuplicateJsonKeyError(key, keyOffset);
      }
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.value();
      this.skipWhitespace();
      if (this.peek("}")) {
        this.offset += 1;
        return;
      }
      this.expect(",");
    }
  }

  private array(): void {
    this.expect("[");
    this.skipWhitespace();
    if (this.peek("]")) {
      this.offset += 1;
      return;
    }
    while (true) {
      this.value();
      this.skipWhitespace();
      if (this.peek("]")) {
        this.offset += 1;
        return;
      }
      this.expect(",");
    }
  }

  private string(): string {
    const start = this.offset;
    this.expect('"');
    let escaped = false;
    while (this.offset < this.source.length) {
      const token = this.source[this.offset]!;
      this.offset += 1;
      if (escaped) {
        if (token === "u") {
          const hex = this.source.slice(this.offset, this.offset + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new SyntaxError(`Invalid Unicode escape at offset ${this.offset}`);
          }
          this.offset += 4;
        } else if (!'"\\/bfnrt'.includes(token)) {
          throw new SyntaxError(`Invalid escape at offset ${this.offset - 1}`);
        }
        escaped = false;
      } else if (token === "\\") {
        escaped = true;
      } else if (token === '"') {
        return JSON.parse(this.source.slice(start, this.offset)) as string;
      } else if (token.charCodeAt(0) < 0x20) {
        throw new SyntaxError(`Unescaped control character at offset ${this.offset - 1}`);
      }
    }
    throw new SyntaxError(`Unterminated string at offset ${start}`);
  }

  private literal(expected: string): void {
    if (this.source.slice(this.offset, this.offset + expected.length) !== expected) {
      throw new SyntaxError(`Unexpected token at offset ${this.offset}`);
    }
    this.offset += expected.length;
  }

  private number(): void {
    const remaining = this.source.slice(this.offset);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remaining);
    if (!match) {
      throw new SyntaxError(`Expected JSON value at offset ${this.offset}`);
    }
    this.offset += match[0].length;
  }

  private expect(token: string): void {
    if (!this.peek(token)) {
      throw new SyntaxError(`Expected ${JSON.stringify(token)} at offset ${this.offset}`);
    }
    this.offset += token.length;
  }

  private peek(token: string): boolean {
    return this.source.startsWith(token, this.offset);
  }

  private skipWhitespace(): void {
    while (this.offset < this.source.length && /\s/.test(this.source[this.offset]!)) {
      this.offset += 1;
    }
  }
}

export function strictJsonParse(source: string): unknown {
  new DuplicateKeyScanner(source).scan();
  return JSON.parse(source) as unknown;
}
