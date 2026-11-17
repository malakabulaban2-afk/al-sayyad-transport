#!/usr/bin/env python3
from pathlib import Path
import plistlib
import sys

root = Path("ios")
if not root.exists():
    print("No ios/ directory; run npx cap add ios first.")
    sys.exit(0)

files = [p for p in root.rglob("Info.plist") if "Pods" not in p.parts]
if not files:
    print("Info.plist not found in generated iOS project.")
    sys.exit(1)

for path in files:
    try:
        with path.open("rb") as f:
            data = plistlib.load(f)
        data["NSLocationWhenInUseUsageDescription"] = (
            "يستخدم تطبيق نقليات الصياد موقعك لتسجيل موقع الشاحنة أثناء الدوام."
        )
        data["NSLocationAlwaysAndWhenInUseUsageDescription"] = (
            "يشارك التطبيق موقع الشاحنة مع إدارة الشركة طوال فترة الدوام، حتى عند عمل التطبيق في الخلفية."
        )
        data["NSLocationAlwaysUsageDescription"] = (
            "يحتاج التطبيق إلى الموقع أثناء الدوام لمتابعة موقع الشاحنة."
        )
        modes = set(data.get("UIBackgroundModes", []))
        modes.add("location")
        data["UIBackgroundModes"] = sorted(modes)
        with path.open("wb") as f:
            plistlib.dump(data, f, sort_keys=False)
        print("Updated:", path)
    except Exception as exc:
        print("Could not update", path, ":", exc)
        sys.exit(1)
