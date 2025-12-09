import { Component, Prop, State, Watch, h } from '@stencil/core';

/**
 * <lido-standalone> usage example:
 *
 *   <lido-standalone
 *     base-url="https://example.com/path/to/folder/lido-game"
 *     xml-path="https://example.com/path/to/folder/lido-game/assets/xmlData.xml"
 *     initial-index="2"
 *     canplay="true"
 *     height="75vh"
 *   ></lido-standalone>
 *
 * This attempts to load the external Lido scripts at runtime (from `baseUrl`).
 * If they aren't found, it falls back to loading the Lido npm package
 * and calls defineCustomElements(...) to register <lido-home>.
 */
@Component({
  tag: 'lido-standalone',
  styleUrl: 'lido-standalone.css',
  shadow: false,
})
export class LidoStandalone {
  /**
   * The public URL where the unzipped Lido code is hosted, e.g.
   * "https://example.com/path/to/lido-game".
   *
   * Inside that folder, we expect:
   *   - code/lido-player.esm.js
   *   - code/lido-player.js
   *   - assets/ (optional)
   */
  @Prop() baseUrl: string = '';

  /**
   * If provided, we'll fetch this XML path once and pass the loaded string
   * to <lido-home>'s `xml-data` attribute.
   */
  @Prop() xmlPath?: string;

  /** The initial index to pass down to <lido-home>. Defaults to 0. */
  @Prop() initialIndex: number = 0;

  /** Whether the <lido-home> can play. Defaults to false. */
  @Prop() canplay: boolean = false;

  /** The height prop to pass to <lido-home>. Defaults to "75vh". */
  @Prop() height: string = '75vh';

  /**
   * Optional prop for directly providing XML data instead of fetching.
   */
  @Prop() xmlData?: string;

  /**
    * If provided(in index.html) → tries versioned script loading from config.json.
    * If no version is found → automatically falls back to default player loading.
    * If not provided → version management is skipped entirely and falls back to default player loading.
   */
  @Prop() codeFolderPath?: string;

  /** Whether scripts are already injected (remote or fallback). */
  @State() scriptsInjected: boolean = false;

  /** Stores the fetched or provided XML data. */
  @State() localXmlData?: string;

  /** This might be used by <lido-home> if referencing assets. */
  @State() xmlBaseUrl?: string;

  // Re-inject scripts if the baseUrl changes
  @Watch('baseUrl')
  onBaseUrlChange() {
    this.injectLidoScripts();
  }

  // Re-fetch XML if the xmlPath changes
  @Watch('xmlPath')
  onXmlPathChange() {
    this.fetchXmlData();
  }

  componentWillLoad() {
    // 1) Attempt to inject the Lido scripts from baseUrl
    this.injectLidoScripts();
    // 2) Fetch the XML (or use the xmlData if provided)
    this.fetchXmlData();
  }

  private async injectLidoScripts() {
    console.log('injectLidoScripts() called. baseUrl=', this.baseUrl);

    // If no baseUrl is provided OR we already injected scripts, just go to fallback
    if (!this.baseUrl) {
      console.warn('lido-standalone: No baseUrl provided. Using npm fallback...');
      this.fallbackNpmImport();
      return;
    }
    if (this.scriptsInjected) {
      return;
    }

    // Synchronously check if remote ESM script exists at baseUrl/code/lido-player.esm.js
    const cleanBase = this.baseUrl.replace(/\/+$/, '');
    const scriptCheckUrl = `${cleanBase}/code/lido-player.esm.js`;
    const fileExists = this.doesFileExistSync(scriptCheckUrl);

    // --------------- CASE: NO codeFolderPath PROVIDED ---------------
    // Try loading version from default /code_versions folder
    // --------------- SINGLE CASE: codeFolderPath PROVIDED ---------------
  if (fileExists && this.codeFolderPath) {
    const cleanBase = this.baseUrl.replace(/\/+$/, "");
    try {
      // -------------------------------------------------------------
      // 1️⃣ CHECK IF ZIP ALREADY CONTAINS /code/ folder
      // -------------------------------------------------------------
      const codeTestUrl = `${cleanBase}/code/lido-player.esm.js`;
      const codeResp = await fetch(codeTestUrl, { method: "HEAD" });
      const contentType = codeResp.headers.get("content-type") || "";

      const codeFolderExists = codeResp.ok && contentType.includes("javascript"); // OR application/x-javascript

      if (codeFolderExists) {
        console.log("%c USING THE CODE FOLDER... ","color: #3bffe8ff; background:#d32f2f; font-size: 15px; font-weight: bold; padding: 6px 10px; border-radius: 4px;");

        console.debug("Lesson ZIP already contains /code → Using embedded code folder");

        const scriptEsm = document.createElement("script");
        scriptEsm.type = "module";
        scriptEsm.src = codeTestUrl;
        document.head.appendChild(scriptEsm);

        const scriptNoModule = document.createElement("script");
        scriptNoModule.setAttribute("nomodule", "");
        scriptNoModule.src = `${cleanBase}/code/lido-player.js`;
        document.head.appendChild(scriptNoModule);

        this.scriptsInjected = true;
        return;
      }
      const lessonCfgUrl = `${cleanBase}/config.json`;
      try {
          // 1️⃣ Load lesson config.json safely
          let lessonCfg: any = {};
          let lessonVersion: string | null = null;

          try {
            const lessonResp = await fetch(lessonCfgUrl);
            if (!lessonResp.ok) throw new Error("Lesson config.json missing");

            // Check for empty file (0 bytes)
            const text = await lessonResp.text();
            if (text.trim().length > 0) {
              lessonCfg = JSON.parse(text);
            } else {
              console.warn("Lesson config.json is EMPTY → falling back to latest version");
            }

            lessonVersion = lessonCfg.code_version;
            console.log(`%c USING THE VERSION FOLDER--> ${lessonVersion} `,"color: #3bffe8ff; background:#d32f2f; font-size: 15px; font-weight: bold; padding: 6px 10px; border-radius: 4px;");

          } catch (parseErr) {
            console.warn("Lesson config.json invalid or unreadable → fallback to latest version");
            lessonVersion = null;
          }

          // Normalize invalid versions
          if (!lessonVersion || typeof lessonVersion !== "string" || lessonVersion.trim() === "") {
            console.warn("Lesson has NO valid codeVersion → using latest version in code-folder-path");
            lessonVersion = null;
          }

          // 2️⃣ Load version list from code-folder-path/config.json
          const codeCfgUrl = `${this.codeFolderPath.replace(/\/+$/, '')}/config.json`;
          const codeResp = await fetch(codeCfgUrl);
          if (!codeResp.ok) throw new Error("Code-folder config.json missing");

          const codeCfg = await codeResp.json();
          const availableVersions: string[] = codeCfg.versions || [];

          if (!availableVersions.length) {
            throw new Error("No versions listed in code-folder config.json");
          }

          // 3️⃣ Compute selected version
          let selectedVersion: string | undefined = null;

          if (lessonVersion) {
            selectedVersion = availableVersions.find(v => v.includes(lessonVersion));
          }

          // Fallback: use latest version
          if (!selectedVersion) {
            selectedVersion = availableVersions[availableVersions.length - 1];
            console.log(`%c USING THE LATEST VERSION FOLDER-> ${selectedVersion} `,"color: #3bffe8ff; background:#d32f2f; font-size: 15px; font-weight: bold; padding: 6px 10px; border-radius: 4px;");
          }

          // 4️⃣ Inject scripts
          const versionDir = `${this.codeFolderPath}/${selectedVersion}`;
          const esmUrl = `${versionDir}/lido-player.esm.js`;
          const noModuleUrl = `${versionDir}/lido-player.js`;

          // Check if version folder exists
          const headCheck = await fetch(esmUrl, { method: "HEAD" });
          if (!headCheck.ok) throw new Error(`Versioned script missing: ${esmUrl}`);

          // Inject main module file
          const scriptEsm = document.createElement("script");
          scriptEsm.type = "module";
          scriptEsm.src = esmUrl;
          document.head.appendChild(scriptEsm);

          // Inject fallback nomodule script
          const scriptNoModule = document.createElement("script");
          scriptNoModule.setAttribute("nomodule", "");
          scriptNoModule.src = noModuleUrl;
          document.head.appendChild(scriptNoModule);

          this.scriptsInjected = true;
          console.debug("Loaded Lido version from:", versionDir);

        }catch (err) {
          console.warn("Failed to load versioned scripts, falling back to npm:", err);
          this.fallbackNpmImport();
        } 
    } catch (err) {
      console.warn("Failed loading scripts → fallback to npm:", err);
      this.fallbackNpmImport();
    }
  }

  else{
        // Otherwise, fallback to the npm package
      console.warn(`Could not find remote scripts at "${scriptCheckUrl}". Falling back to npm package "lido-player"...`);
      this.fallbackNpmImport();
      }
  }

  /**
   * Synchronously checks if a file exists via HTTP HEAD request.
   * Returns true if status is 2xx, false otherwise.
   */
  private doesFileExistSync(url: string): boolean {
    let exists = false;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('HEAD', url, false); // false = synchronous
      xhr.send(null);
      exists = xhr.status >= 200 && xhr.status < 300;
    } catch (err) {
      console.warn('Synchronous HEAD request failed for:', url, err);
    }
    return exists;
  }

  /**
   * Fallback approach: dynamically import the "lido-player/loader" module,
   * then call defineCustomElements(window) to register the <lido-home> component.
   * This is asynchronous by nature.
   */
  private fallbackNpmImport() {
    import('lido-player/loader')
      .then(({ defineCustomElements }) => {
        // Register custom elements on 'window'
        defineCustomElements(window);
        // Mark scripts as loaded so we can proceed
        this.scriptsInjected = true;
        console.debug('Lido scripts loaded via npm fallback (defineCustomElements).');
      })
      .catch(err => {
        console.error('Failed to load from npm package "lido-player":', err);
      });
  }

  private fetchXmlData() {
    // If the user provided raw XML data, just store it
    if (this.xmlData) {
      this.localXmlData = this.xmlData;
      return;
    }

    // If xmlPath is not explicitly provided, default to `index.xml` in baseUrl
    if (!this.xmlPath) {
      if (this.baseUrl) {
        const cleanBase = this.baseUrl.replace(/\/+$/, '');
        this.xmlPath = `${cleanBase}/index.xml`;
        this.xmlBaseUrl = this.baseUrl;
      } else {
        return;
      }
    }

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', this.xmlPath, false); // false = synchronous
      xhr.send(null);

      if (xhr.status >= 200 && xhr.status < 300) {
        this.localXmlData = xhr.responseText;
      } else {
        console.warn(`Failed to fetch XML from ${this.xmlPath}:`, xhr.status);
      }
    } catch (err) {
      console.warn(`Error fetching XML from ${this.xmlPath}:`, err);
    }
  }

  render() {
    /**
     * If you want to hide <lido-home> until the fallback is fully loaded,
     * you could do something like:
     *
     * if (!this.scriptsInjected) {
     *   return <div>Loading Lido...</div>;
     * }
     *
     * This ensures the custom elements are defined before usage.
     */

    return <lido-home initial-index={this.initialIndex} canplay={this.canplay} height={this.height} xml-data={this.localXmlData} base-url={this.xmlBaseUrl} code-folder-path={this.codeFolderPath}></lido-home>;
  }

  
}


