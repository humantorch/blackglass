import os, sys, fcntl, termios, struct, selectors


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    cmd = sys.argv[1:]
    if not cmd:
        sys.exit(1)

    master_fd, slave_fd = os.openpty()

    pid = os.fork()
    if pid == 0:
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        for target in (0, 1, 2):
            os.dup2(slave_fd, target)
        os.close(master_fd)
        os.close(slave_fd)
        os.execvp(cmd[0], cmd)
        sys.exit(1)

    os.close(slave_fd)

    sel = selectors.DefaultSelector()
    sel.register(sys.stdin.buffer, selectors.EVENT_READ, "stdin")
    sel.register(master_fd, selectors.EVENT_READ, "pty")
    cmdio = os.fdopen(3, "rb")
    sel.register(cmdio, selectors.EVENT_READ, "resize")

    running = True
    while running:
        for key, _ in sel.select(timeout=0.05):
            if key.data == "stdin":
                data = os.read(sys.stdin.fileno(), 4096)
                if not data:
                    running = False
                    break
                os.write(master_fd, data)
            elif key.data == "pty":
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        running = False
                        break
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                except OSError:
                    running = False
                    break
            elif key.data == "resize":
                line = cmdio.readline()
                if line:
                    try:
                        cols, rows = (int(x) for x in line.decode().strip().split("x"))
                        set_size(master_fd, cols, rows)
                    except ValueError:
                        pass

    _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        sys.exit(os.WEXITSTATUS(status))
    sys.exit(1)


main()
