# niimbluelib.browser.min.js

Vendored browser build of [`@mmote/niimbluelib`](https://github.com/MultiMote/niimbluelib)
v0.46.0 (MIT license), the library behind the [niimblue](https://mmote.github.io/niimblue/)
web app used to talk to Niimbot label printers over Web Bluetooth.

Bundled with esbuild as a single IIFE exposing the global `Niimblue`. The
Capacitor-based BLE client (`NiimbotCapacitorBleClient`) was dropped before
bundling since it's native-app only and pulls in `@capacitor-community/bluetooth-le`
/ `@capacitor/core` for no benefit here — everything else (Web Bluetooth,
Web Serial, packet protocol, image encoder, print tasks for B1/B21/D11/D110/H1S...)
is untouched.

To rebuild after a version bump:

```sh
npm install @mmote/niimbluelib@<version> esbuild --no-save
mkdir vendor-src && cp -r node_modules/@mmote/niimbluelib/dist/cjs/* vendor-src/
# remove vendor-src/client/capacitor_ble_impl.js and drop it from vendor-src/client/index.js
cat > entry.js <<'EOF'
export * from "./vendor-src/index";
export { BleDefaultConfiguration } from "./vendor-src/client/bluetooth_impl";
EOF
npx esbuild entry.js --bundle --format=iife --global-name=Niimblue --platform=browser --minify --legal-comments=none --outfile=niimbluelib.browser.min.js
```

Used from `../index.html` as `<script src="vendor/niimbluelib.browser.min.js"></script>`,
which defines `window.Niimblue`.
