//the relay's state on disk: one JSON file, written to a temp file and renamed (a crash never leaves half a file).
//The file before it is kept as .bak: a file that does not parse (disk trouble, an edit by hand) is set aside and
//the .bak is read instead
import { closeSync, copyFileSync, existsSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export class JsonStore<T> {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly path: string,
    private get: () => T,
    private delayMs = 200,
  ) {}

  load(log: (msg: string) => void = console.warn): T | null {
    const bak = `${this.path}.bak`;
    for (const p of [this.path, bak]) {
      if (!existsSync(p)) {
        continue;
      }
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as T;
      } catch (e) {
        const aside = `${p}.corrupt-${Date.now()}`;
        renameSync(p, aside);
        log(`state file ${p} does not parse (${(e as Error).message}), moved to ${aside}`);
      }
    }
    return null;
  }

  //write soon (changes in a burst become one write)
  changed() {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.delayMs);
    }
  }

  flush() {
    const tmp = `${this.path}.tmp`;
    //owner only: the maker program's state holds its agent key (the .bak copy takes the same mode)
    const fd = openSync(tmp, 'w', 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify(this.get(), null, 1));
    fsyncSync(fd);
    closeSync(fd);
    if (existsSync(this.path)) {
      copyFileSync(this.path, `${this.path}.bak`);
    }
    renameSync(tmp, this.path);
  }
}
