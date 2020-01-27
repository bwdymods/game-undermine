const
  fs = require('fs'),
  path = require('path'),
  Promise = require('bluebird'),
  rjson = require('relaxed-json'),
  { promisify } = require('util'),
  { actions, log, util } = require('vortex-api'),
  winapi = require('winapi-bindings'),
  {runPatcher} = require('harmony-patcher');

const MOD_JSON = 'mod.json';
const GAME_ID = 'undermine';
const ROOT_PATTERN = path.sep + 'UnderMine_Data' + path.sep;
const HOOK_ASSEMBLY = path.join('Undermine_Data', 'Managed', 'UnderMine.dll');
const HOOK_ENTRYPOINT = 'Thor.Game::Awake'

class UnderMine {
  /*********
  ** Vortex API
  *********/
  /**
   * Construct an instance.
   * @param {IExtensionContext} context -- The Vortex extension context.
   */
  constructor(context) {
    this.context = context;
    this.id = GAME_ID;
    this.name = 'UnderMine';
    this.logo = 'gameart.png';
    this.requiredFiles = ['UnderMine.exe', 'UnderMine_Data/Managed/UnderMine.dll']
    this.details = { steamAppId: 656350 };
	this.environment = { SteamAPPId: '656350' };
    this.mergeMods = true;
    this.requiresCleanup = true;
    this.shell = process.platform == 'win32';
	this.launcher = 'steam';
  }

  /**
   * Asynchronously find the game install path.
   *
   * This function should return quickly and, if it returns a value, it should definitively be the
   * valid game path. Usually this function will query the path from the registry or from steam.
   * This function may return a promise and it should do that if it's doing I/O.
   *
   * This may be left undefined but then the tool/game can only be discovered by searching the disk
   * which is slow and only happens manually.
   */
  async queryPath() {
	return util.steam.findByAppId('656350').then(game => game.gamePath);
  }

  /**
   * Get the path of the tool executable relative to the tool base path, i.e. binaries/UT3.exe or
   * TESV.exe. This is a function so that you can return different things based on the operating
   * system for example but be aware that it will be evaluated at application start and only once,
   * so the return value can not depend on things that change at runtime.
   */
  executable() {
    return 'UnderMine.exe';
  }

  /**
   * Get the default directory where mods for this game should be stored.
   * 
   * If this returns a relative path then the path is treated as relative to the game installation
   * directory. Simply return a dot ( () => '.' ) if mods are installed directly into the game
   * directory.
   */ 
  queryModPath()
  {
    return 'Mods';
  }

  async checkUnderModStatus(discovery)
  {
    //run patcher now that we have consent
	const absPath = path.join(discovery.path, HOOK_ASSEMBLY);
	runPatcher(__dirname, absPath, HOOK_ENTRYPOINT, false);
	
	//skip if UnderMod is found
    let undermodPath = path.join(discovery.path, 'UnderMine_Data', 'Managed', 'VortexMods', 'UnderMod', 'UnderMod.dll');
    if (await this.getPathExistsAsync(undermodPath)) return;
	
	//skip if optout is found
	let umOptFile = path.join(discovery.path, 'vortex-no-undermod-prompt.txt');
	if (await this.getPathExistsAsync(umOptFile)) return;
	
	//show UnderMod prompt
	let umUrl = 'https://www.nexusmods.com/undermine/mods/1';
    var context = this.context;
    return new Promise((resolve, reject) => {
      context.api.store.dispatch(
        actions.showDialog(
          'question',
          'Action required',
          { text: 'Most UnderMine mods require UnderMod (an modding API for UnderMine) to run. Vortex can install UnderMod for you.' },
          [
            { label: 'I Do Not Want To Install UnderMod', action: () => { this.underModOptOut(umOptFile); resolve(); } },
            { label: 'Remind Me Later', action: () => {resolve();}  },
            { label: 'Get UnderMod', action: () => { util.opn(umUrl).catch(err => undefined); resolve();} }
          ]
        )
      );
    });
  }
  
  async underModOptOut(f)
  {
	let txt = "Vortex created this file to store your preference regarding UnderMod.";
	fs.writeFile(f, txt, (err) => {
	  if (err) throw err;
	});
  }

  /**
   * Optional setup function. If this game requires some form of setup before it can be modded (like
   * creating a directory, changing a registry key, ...) do it here. It will be called every time
   * before the game mode is activated.
   * @param {IDiscoveryResult} discovery -- basic info about the game being loaded.
   */
  async setup(discovery)
  {
	//check vortex patch consent
	let patchBackupPath = path.join(discovery.path, 'UnderMine_Data', 'Managed', 'UnderMine.dll_vortex_assembly_backup');
    if (await this.getPathExistsAsync(patchBackupPath))
	{
	  //we already have consent as the game has already been patched in the past
	  await this.checkUnderModStatus(discovery);
	  return;
	} else {
	  //we do not have consent. prompt the user
	  var context = this.context;
      return new Promise((resolve, reject) => {
        context.api.store.dispatch(
          actions.showDialog(
            'question',
            'Patch Game Files to Enable Mods?',
            { text: 'For UnderMine to support mods (including the modding API, UnderMod itself), Vortex needs to patch some game files. Vortex will maintain this patch for you automatically if the game is updated or otherwise modified, each time you manage the game in Vortex.  Would you like to continue?' },
            [
              { label: 'Cancel', action: () => reject(new util.UserCanceled()) },
              { label: 'Enable Mods', action: () => {this.checkUnderModStatus(discovery); resolve(); } }
            ]
          )
        );
      });
	}
  }

  async getPathExistsAsync(path)
  {
    try {
     await promisify(fs.access)(path, fs.constants.R_OK);
     return true;
    }
    catch(err) {
      return false;
    }
  }
}

  /*********
  ** Internal methods
  *********/
  /**
   * Asynchronously check whether a file or directory path exists.
   * @param {string} path - The file or directory path.
   */
async function getModName(destinationPath, manifestFile) {
  const manifestPath = path.join(destinationPath, manifestFile);
  try {
    const file = await promisify(fs.readFile)(manifestPath, { encoding: 'utf8' });
    const data = rjson.parse(util.deBOM(file));
    return (data.Name !== undefined)
      ? Promise.resolve(data.Name.replace(/[^a-zA-Z0-9]/g, ''))
      : Promise.reject(new util.DataInvalid('Invalid mod.json file'));
  } catch(err) {
    log('error', 'Unable to parse mod.json file', manifestPath);
    return path.basename(destinationPath, '.installing');
  }
}

async function testRootFolder(files, gameId) {
  // We assume that any mod containing "/UnderMine_Data/" in its directory
  //  structure is meant to be deployed to the root folder.
  const filtered = files.filter(file => file.endsWith(path.sep))
    .map(file => path.join('fakeDir', file));
  const contentDir = filtered.find(file => file.endsWith(ROOT_PATTERN));
  const supported = ((gameId === GAME_ID)
    && (contentDir !== undefined));

  return { supported };
}

async function installRootFolder(files, destinationPath) {
  // We're going to deploy "/UnderMine_Data/" and whatever folders come alongside it.
  //  i.e. SomeMod.7z
  //  Will be deployed     => ../SomeMod/UnderMine_Data/
  //  Will be deployed     => ../SomeMod/Mods/
  //  Will NOT be deployed => ../Readme.doc
  const contentFile = files.find(file => path.join('fakeDir', file).endsWith(ROOT_PATTERN));
  const idx = contentFile.indexOf(ROOT_PATTERN) + 1;
  const rootDir = path.basename(contentFile.substring(0, idx));
  const filtered = files.filter(file => (path.extname(file) !== '')
    && (file.indexOf(rootDir) !== -1)
    && (path.extname(file) !== '.txt'));
  const instructions = filtered.map(file => {
    return {
      type: 'copy',
      source: file,
      destination: file.substr(idx),
    };
  });

  return { instructions };
}

async function testSupported(files, gameId) {
  const supported = (gameId === GAME_ID)
    && (files.find(file => path.basename(file).toLowerCase() === MOD_JSON) !== undefined)
    && (files.find(file => {
	  // We create a prefix fake directory just in case the content
      //  folder is in the archive's root folder. This is to ensure we
      //  find a match for "/UnderMine_Data/"
      const testFile = path.join('fakeDir', file);
      return (testFile.endsWith(ROOT_PATTERN));
    }) === undefined);
  return { supported }
}

async function install(files, destinationPath, gameId, progressDelegate) {
  const manifestFiles = files.filter(file =>
    path.basename(file).toLowerCase() === MOD_JSON);
  // The archive may contain multiple mod.json files which would
  //  imply that we're installing multiple mods.
  const mods = manifestFiles.map(manifestFile => {
    const rootFolder = path.dirname(manifestFile);
    const manifestIndex = manifestFile.indexOf(MOD_JSON);
    const modFiles = files.filter(file =>
      (file.indexOf(rootFolder) !== -1)
      && (path.dirname(file) !== '.')
      && (path.extname(file) !== ''));

    return {
      manifestFile,
      rootFolder,
      manifestIndex,
      modFiles,
    };
  });

  return Promise.map(mods, mod => getModName(destinationPath, mod.manifestFile)
    .then(manifestModName => {
      const modName = (mod.rootFolder !== '.') ? mod.rootFolder : manifestModName;

      return mod.modFiles.map(file => {
        const destination = path.join(modName, file.substr(mod.manifestIndex));
        return {
          type: 'copy',
          source: file,
          destination: destination,
        };
      });
    }))
    .then(data => {
      const instructions = [].concat.apply([], data);
      return Promise.resolve({ instructions });
    });
}

module.exports = {
  default: function(context) {
    const getDiscoveryPath = () => {
      const state = context.api.store.getState();
      const discovery = util.getSafe(state, ['settings', 'gameMode', 'discovered', GAME_ID], undefined);
      if ((discovery === undefined) || (discovery.path === undefined)) {
        // should never happen and if it does it will cause errors elsewhere as well
        log('error', 'UnderMine was not discovered');
        return undefined;
      }

      return discovery.path;
    }
    context.registerGame(new UnderMine(context));
    context.registerInstaller('undermine-installer', 50, testSupported, install);
    context.registerInstaller('undermine-root', 50, testRootFolder, installRootFolder);
    context.registerModType('undermine-root', 25, (gameId) => (gameId === GAME_ID),
      () => getDiscoveryPath(), (instructions) => {
        // Only interested in copy instructions.
        const copyInstructions = instructions.filter(instr => instr.type === 'copy');
		// This is a tricky pattern so we're going to 1st present the different packaging
        //  patterns we need to cater for:
        //  1. Replacement mod with "UnderMine_Data" folder. Does not require UnderMod so no
        //    manifest files are included.
        //  2. Replacement mod with "UnderMine_Data" folder + one or more UnderMod mods included
        //    alongside the UnderMine_Data folder inside a "Mods" folder.
        //  3. A regular UnderMod mod with a "UnderMine_Data" folder inside the mod's root dir.
        //
        // pattern 1:
        //  - Ensure we don't have manifest files
        //  - Ensure we have a "UnderMine_Data" folder
        //
        // To solve patterns 2 and 3 we're going to:
        //  Check whether we have any manifest files, if we do, we expect the following
        //    archive structure in order for the modType to function correctly:
        //    archive.zip =>
        //      ../UnderMine_Data/
        //      ../Mods/
        //      ../Mods/SomeUnderModMod/manifest.json
        const hasManifest = copyInstructions.find(instr =>
          instr.destination.endsWith(MOD_JSON))
        const hasModsFolder = copyInstructions.find(instr =>
          instr.destination.startsWith('Mods' + path.sep)) !== undefined;
        const hasContentFolder = copyInstructions.find(instr =>
          instr.destination.startsWith('UnderMine_Data' + path.sep)) !== undefined
        return (hasManifest)
          ? Promise.resolve(hasContentFolder && hasModsFolder)
          : Promise.resolve(hasContentFolder);
      });
  }
}