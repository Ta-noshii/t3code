#!/usr/bin/env bash
# Drives the release APK far enough to open a thread, saving screens and logcat.
set -u
OUT=out; mkdir -p "$OUT"
PKG=com.tanoshii.t3code.nowbar
n=0
shot() { n=$((n+1)); adb exec-out screencap -p > "$OUT/$(printf %02d $n)-$1.png"; adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb pull /sdcard/ui.xml "$OUT/$(printf %02d $n)-$1.xml" >/dev/null 2>&1; }
tap_text() { # tap the first node whose text or content-desc matches $1
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb pull /sdcard/ui.xml /tmp/ui.xml >/dev/null 2>&1
  python3 - "$1" <<'PY' | { read -r x y && [ -n "$x" ] && adb shell input tap "$x" "$y" && echo "tapped $1 at $x,$y" || echo "no match for $1"; }
import re,sys,xml.etree.ElementTree as ET
pat=re.compile(sys.argv[1],re.I)
for e in ET.parse('/tmp/ui.xml').iter('node'):
  if pat.search(e.get('text','')) or pat.search(e.get('content-desc','')) or pat.search(e.get('hint','') or ''):
    a,b,c,d=map(int,re.findall(r'\d+',e.get('bounds')));hit=((a+c)//2,(b+d)//2)
print(*hit) if 'hit' in dir() else None
PY
}
adb shell getprop ro.product.cpu.abilist > "$OUT/abilist.txt"
adb shell getprop ro.build.version.release >> "$OUT/abilist.txt"
adb install -r app.apk > "$OUT/install.txt" 2>&1 || { cat "$OUT/install.txt"; exit 0; }
adb logcat -c
adb logcat -v threadtime > "$OUT/logcat.txt" 2>&1 &
LOGPID=$!
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null
adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 25; shot launch
adb shell am start -a android.intent.action.VIEW -d "t3code-nowbar://connections/new" $PKG >/dev/null; sleep 8; shot connections-new
tap_text '^Host$'; sleep 3; adb shell input text "$T3_DEBUG_HOST"; sleep 2
tap_text '^Pairing code$'; sleep 3; adb shell input text "$T3_DEBUG_TOKEN"; sleep 2
adb shell input keyevent 111; sleep 2; shot filled
tap_text '^Add environment$'; sleep 20; shot paired
shot home
tap_text 'Community Department'; sleep 8; shot tapped-thread-8s; sleep 15; shot tapped-thread-23s
adb shell input keyevent 4; sleep 4; shot tapped-after-back
adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 8
adb shell am start -a android.intent.action.VIEW -d "t3code-nowbar://threads/fd7edc01-e675-4e31-8684-22927ce054ee/02cb7b2f-ac62-4636-90ac-e812e9c01ac4" $PKG >/dev/null
sleep 6; shot thread-6s; sleep 20; shot thread-26s
tap_text 'message|ask|follow'; sleep 6; shot composer-focused
adb shell input keyevent 111; sleep 4; shot composer-dismissed
adb shell input keyevent 4; sleep 4; shot after-back
adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" > "$OUT/activity.txt"
adb shell pidof $PKG >> "$OUT/activity.txt"
kill $LOGPID 2>/dev/null
adb logcat -d -b crash > "$OUT/crash.txt" 2>&1
exit 0
