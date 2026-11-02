import os
import pwd
import sys


def select_session(sessions):
    if not sessions:
        raise ValueError("No running desktop user's XFCE session found")
    if len(sessions) != 1:
        raise ValueError("Multiple desktop XFCE sessions found; select a screen explicitly")
    return sessions[0]


def main():
    user = pwd.getpwnam("desktop")
    sessions = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            path = "/proc/" + name
            if os.stat(path).st_uid != user.pw_uid:
                continue
            with open(path + "/comm") as comm:
                if comm.read().strip() != "xfce4-session":
                    continue
            with open(path + "/environ", "rb") as source:
                environment = dict(part.split(b"=", 1) for part in source.read().split(b"\0") if b"=" in part)
            sessions.append(environment)
        except (FileNotFoundError, ProcessLookupError):
            continue
    try:
        environment = select_session(sessions)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    values = ["HOME=" + user.pw_dir, "USER=desktop", "LOGNAME=desktop"]
    for key in [b"DISPLAY", b"DBUS_SESSION_BUS_ADDRESS", b"XDG_RUNTIME_DIR"]:
        if key in environment:
            values.append(os.fsdecode(key + b"=" + environment[key]))
    os.execvp("runuser", ["runuser", "-u", "desktop", "--", "env", *values, *sys.argv[1:]])


if __name__ == "__main__":
    main()
