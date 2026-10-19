import { enabled } from './colors.js';

const DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// A single-line spinner. With no terminal it degrades to plain status lines,
// so piped output still shows what the command is waiting on.
export function createSpinner(initialText) {
  let text = String(initialText ?? '');
  let frame = 0;
  let timer = null;
  let running = false;
  const tty = process.stdout.isTTY === true;

  const paint = () => {
    if (!tty) return;
    frame++;
    const glyph = enabled ? DOTS[frame % DOTS.length] : ' ';
    process.stdout.write(`\r${glyph} ${text}\x1b[K`);
  };

  return {
    start() {
      running = true;
      if (tty) {
        paint();
        timer = setInterval(paint, 100);
      } else {
        // Pipelines and logs: one plain line instead of the animation.
        process.stdout.write(`${text}\n`);
      }
    },
    update(next) {
      text = String(next);
      if (running && !tty) process.stdout.write(`${text}\n`);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      running = false;
      if (tty) process.stdout.write('\r\x1b[K');
    },
  };
}
