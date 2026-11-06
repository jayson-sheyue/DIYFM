# Third-party components

The public runtime hosts these libraries on the same site. It does not load them from a third-party CDN.

| Component | Version | Purpose | License / source |
| --- | --- | --- | --- |
| lamejs | 1.2.1 | MP3 encoding in a Web Worker | GNU LGPL v3; [upstream notice](static/vendor/lamejs-LICENSE.txt), [full LGPL](static/vendor/COPYING.LESSER), [incorporated GPL](static/vendor/COPYING.GPL); [source](https://github.com/zhuker/lamejs), [exact npm source archive](https://registry.npmjs.org/lamejs/-/lamejs-1.2.1.tgz) |
| fflate | 0.8.2 | ZIP backup and import | MIT; `static/vendor/fflate-LICENSE.txt`; [source](https://github.com/101arrowz/fflate) |
| fake-indexeddb | 6.2.4 | Node tests only; not shipped in `dist/` | Apache-2.0; [source](https://github.com/dumbmatter/fakeIndexedDB) |

`package-lock.json` pins package versions and integrity. Run `npm ci --ignore-scripts` then `npm run vendor` to copy the pinned runtime files and license texts. The readable `lame.all.js` corresponding to the minified encoder is included alongside it for inspection and modification. Users can replace/relink this separately hosted library without changing the application; retain its license and notices when redistributing modifications. fflate's bundled `.mjs` is unminified.

The radio illustration is a local SVG maintained with the application. No external image, font, analytics or advertising service is required to open the page.
