# lido-standalone



<!-- Auto Generated Below -->


## Overview

<lido-standalone> usage example:

  <lido-standalone
    base-url="https://example.com/path/to/folder/lido-game"
    xml-path="https://example.com/path/to/folder/lido-game/assets/xmlData.xml"
    initial-index="2"
    canplay="true"
    height="75vh"
  ></lido-standalone>

This attempts to load the external Lido scripts at runtime (from `baseUrl`).
If they aren't found, it falls back to loading the Lido npm package
and calls defineCustomElements(...) to register <lido-home>.

## Properties

| Property       | Attribute       | Description                                                                                                                                                                                                     | Type      | Default     |
| -------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------- |
| `baseUrl`      | `base-url`      | The public URL where the unzipped Lido code is hosted, e.g. "https://example.com/path/to/lido-game".  Inside that folder, we expect:   - code/lido-player.esm.js   - code/lido-player.js   - assets/ (optional) | `string`  | `''`        |
| `canplay`      | `canplay`       | Whether the <lido-home> can play. Defaults to false.                                                                                                                                                            | `boolean` | `false`     |
| `height`       | `height`        | The height prop to pass to <lido-home>. Defaults to "75vh".                                                                                                                                                     | `string`  | `'75vh'`    |
| `initialIndex` | `initial-index` | The initial index to pass down to <lido-home>. Defaults to 0.                                                                                                                                                   | `number`  | `0`         |
| `xmlData`      | `xml-data`      | Optional prop for directly providing XML data instead of fetching.                                                                                                                                              | `string`  | `undefined` |
| `xmlPath`      | `xml-path`      | If provided, we'll fetch this XML path once and pass the loaded string to <lido-home>'s `xml-data` attribute.                                                                                                   | `string`  | `undefined` |


----------------------------------------------

*Built with [StencilJS](https://stenciljs.com/)*
