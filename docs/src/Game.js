import * as THREE from 'three';
import { Player } from './Player.js';
import { EnemySpawner } from './EnemySpawner.js';
import { UI } from './UI.js';
import { Bullet } from './Bullet.js';
import { Minimap } from './Minimap.js';
import { Turret } from './Turret.js';
import { Potion } from './Potion.js';
import { GridPathFinder } from './GridPathFinder.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.150.1/examples/jsm/loaders/GLTFLoader.js';
import { loadingMgr } from './LoadingMgr.js';

export class Game {
  
  constructor(container) {

    this.container = container;
    this._firstFrameDone = false;
    this.isGameOver = false;
    this.paused = false;

    this.initScene();
    this.initCamera();
    this.initRenderer();
    this.initLights();
    
    // Data structures for static models
    this.staticColliders = [];

    this.playerSpawnPos = new THREE.Vector3(0, 0, 0); // actually the player is at y = 1.5 but it's the same
    this.reservedRadius   = 60;                       // metres of clearance
    this.reservedRadiusSq = this.reservedRadius ** 2; 

    // Load all static models, then initialize pathfinding + spawner
    this.loadStaticModels().then(() => {
      this.initPathfinding();
      this.initEnemySpawner();
      this.start();
    });

    // Array to hold active bullets.
    this.bullets = [];

    this.initGameState();
    this.registerEventListeners();
  }

  togglePause() {
    this.paused = !this.paused;
    if (this.paused) {
      this.clock.stop();        // Three’s clock now returns 0 Δt
      this.enemySpawner?.pause?.();
      this.turrets.forEach(t => t.active = false);
      this.ui?.dimStage();      // quick dark overlay you already have
      this.ui?.showFloatingMessage("⏸ Paused", this.player.mesh.position.clone());
    } else {
      this.clock.start();       // resumes from where it left off
      this.enemySpawner?.resume?.();   // add “resume” just like pause
      this.turrets.forEach(t => t.active = true);
      this.ui?.undimStage?.();  // remove the overlay if you expose this
    }
  }

  /* Rough footprint the turret occupies on the ground  ─────────────── */
  static TURRET_RADIUS = 1.6;   // metres (≈ the green cylinder you use)

  /** returns true if the spot is free of static props *and* other turrets */
  isTurretPlacementValid(pos){
    /* 1. build a flat bounding-box around the proposed centre */
    const r = Game.TURRET_RADIUS;
    const bb = new THREE.Box3(
        new THREE.Vector3(pos.x - r, -1, pos.z - r),
        new THREE.Vector3(pos.x + r,  3, pos.z + r)   // a few metres tall
    );

    /* 2. collide with static scenery */
    if (this.staticColliders.some(box => box.intersectsBox(bb))) return false;

    /* 3. collide with already placed turrets */
    for (const t of this.turrets){
      if (t.object.position.distanceToSquared(pos) < (r*2)**2) return false;
    }
    return true;
  }


  initScene() {
    // Create the scene and set a background color.
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x202020);

    // Cobblestone ground
    const texLoader = new THREE.TextureLoader(loadingMgr);

    const gColor  = texLoader.load('assets/ground/pbr/ground_albedo.jpg');
    const gNormal = texLoader.load('assets/ground/pbr/ground_normal.png');
    const gRough  = texLoader.load('assets/ground/pbr/ground_rough.jpg');
    const gAO     = texLoader.load('assets/ground/pbr/ground_ao.png');

    // colour textures must be flagged as sRGB so lighting looks right
    gColor.colorSpace = THREE.SRGBColorSpace;

    // set texture wrapping and tiling
    const TILE_REPEAT = 40;
    [gColor, gNormal, gRough, gAO].forEach(t => {
      if (t) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(TILE_REPEAT, TILE_REPEAT);
        t.anisotropy = 16;
      }
    });

    const groundMaterial = new THREE.MeshStandardMaterial({
      map:           gColor,
      normalMap:     gNormal,
      roughnessMap:  gRough,
      aoMap:         gAO ?? undefined,
      roughness:     1
    });

    // dial the bump strength up or down if needed
    groundMaterial.normalScale.set(0.9, 0.9);
    
    // Create a large plane geometry for the ground (e.g., 1000 x 1000 units)
    const groundGeometry = new THREE.PlaneGeometry(1000, 1000);

    const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
    groundMesh.rotation.x = -Math.PI / 2; // Make the plane horizontal.
    groundMesh.position.y = 0; // Set at ground level.

    // Optionally, allow the ground to receive shadows
    groundMesh.receiveShadow = true;

    // Add the ground to the scene
    this.scene.add(groundMesh);
  }

  initCamera() {
    // Setup camera.
    const aspect = this.container.clientWidth / this.container.clientHeight;

    const viewSize = 100; 
    
    // Calculate orthographic parameters
    const left = -viewSize * aspect / 2;
    const right = viewSize * aspect / 2;
    const top = viewSize / 2;
    const bottom = -viewSize / 2;
    
    // Create an orthographic camera
    this.camera = new THREE.OrthographicCamera(left, right, top, bottom, 0.1, 1000);
    
    // Position the camera for an isometric view.
    // A common setup is to rotate 45° around Y and 35.264° (arctan(1/√2)) above the horizontal.
    this.camera.position.set(40, 40, 40); 
    this.camera.lookAt(new THREE.Vector3(0, 0, 0));
    
    // Store initial camera state ---
    // Calculate the angle (in the XZ plane) from the camera's position.
    this.initialCameraAngle = Math.atan2(this.camera.position.z, this.camera.position.x); // ~45° in radians
    this.cameraAngle = this.initialCameraAngle;
    // Calculate the distance from the center (ignoring Y).
    this.cameraDistance = Math.sqrt(
      this.camera.position.x * this.camera.position.x +
      this.camera.position.z * this.camera.position.z
    );
    // Store the camera's height.
    this.cameraHeight = this.camera.position.y;

    this.cameraVel = new THREE.Vector3();   // starts at rest
    this.fixedCameraCenter = new THREE.Vector3(); // “orbit-about” point in fixed mode
  }

  initRenderer() {
    // Setup renderer.
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.container.appendChild(this.renderer.domElement);
    this.renderer.shadowMap.enabled = true; // Enable shadows
    // Clock for calculating delta time.
    this.clock = new THREE.Clock();
    // this is used to measure game time, shown during game over
    this.sessionStart = performance.now(); 
  }

  initLights() {
    // Setup lighting.
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(this.ambientLight);
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    //this.directionalLight.position.set(0, 50, 50);
    this.directionalLight.position.set(200, 140, 200);
    // make it a shadow-caster
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.set(2048, 2048);   // nicer resolution
    this.directionalLight.shadow.camera.left   = -200;       // tighten the
    this.directionalLight.shadow.camera.right  =  200;       //   orthographic
    this.directionalLight.shadow.camera.top    =  200;       //   shadow frustum
    this.directionalLight.shadow.camera.bottom = -200;
    this.directionalLight.shadow.bias = -0.0005;             // fight acne
    this.scene.add(this.directionalLight);
  }

  async loadStaticModels() {
    await this.loadStaticBarn();
    await this.loadStaticFarm();
    await this.loadStaticTrees();
    await this.loadStaticVehicles();
    // random spawning afterwards
    await this.loadStaticRocks();
    await this.loadStaticFences();

    // force shader compilation so everything is ready for the first frame
    this.renderer.compile(this.scene, this.camera);
    // tell LoadingMgr we’re truly ready
    window.dispatchEvent(new Event('first-render-complete'));
  }

  async loadStaticBarn() {

    const gltfLoader = new GLTFLoader(loadingMgr).setPath('assets/barn/modular_old_wooden_barn_and_fence/'); // base path
    const gltf = await gltfLoader.loadAsync('scene.gltf');

    const barnRoot = gltf.scene;

    /* Nice-to-have defaults */
    barnRoot.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.material.toneMapped = false;      // prevents “washed-out” look
      }
    });

    /* Position / scale to taste */
    barnRoot.position.set(110, 0, -90);
    barnRoot.rotation.y = Math.PI;          // turn 180° if door faces away
    barnRoot.scale.setScalar(30);          // % of the original size

    // compute one big bounding box that encloses the entire barn
    const barnBBox = new THREE.Box3().setFromObject(barnRoot)
                                    .expandByScalar(0.5);   // optional margin


    const texPath = 'assets/barn/modular_old_wooden_barn_and_fence/textures/';
    const tex     = new THREE.TextureLoader(loadingMgr);

    const tBase   = tex.load(texPath + 'MI_wooden_fence_barn_baseColor.png');
    const tMR     = tex.load(texPath + 'MI_wooden_fence_barn_metallicRoughness.png');
    const tNormal = tex.load(texPath + 'MI_wooden_fence_barn_normal.png');

    /* glTF (and UE/Babylon) pack **AO(R)**, **Roughness(G)**, **Metallic(B)**
      into one image.  THREE can share that same texture for both channels.   */
    tBase.colorSpace = THREE.SRGBColorSpace;   // very important!

    /* 2.  Build a MeshStandardMaterial that uses those maps */
    const woodMat = new THREE.MeshStandardMaterial({
      map:           tBase,
      metalnessMap:  tMR,
      roughnessMap:  tMR,
      normalMap:     tNormal,
      // these scalar values get *multiplied* with the map data
      metalness:     1.0,
      roughness:     1.0,
    });
    // optional tweak: make the normal map a little stronger
    woodMat.normalScale.set( 1.0, 1.0 );


    /* 3.  Apply the wood material to every mesh that currently uses
          “wood” (or simply to *every* mesh if you like)              */
    barnRoot.traverse((o) => {
      if (!o.isMesh) return;

      // Option A: blanket-replace all materials
      // o.material = woodMat;

      // Option B: only replace meshes whose original name contains "wood"
      if (o.material.name?.toLowerCase().includes('wood')) {
        o.material = woodMat;
      }
    });
  
    this.scene.add(barnRoot);

    this.staticColliders = this.staticColliders ?? [];          // create once
    barnRoot.updateWorldMatrix( true, true );                   // make sure matrices are up-to-date

    barnRoot.traverse( (o) => {
      if ( !o.isMesh ) return;

      const box = new THREE.Box3().setFromObject( o );         // world-space AABB
      this.staticColliders.push(box);
    }); 
  }

  async loadStaticTrees () {

    const gltf = await new GLTFLoader(loadingMgr)
          .setPath('assets/100_random_low-poly_trees/')
          .loadAsync('scene.gltf');

    // prepare the template just once
    const template = gltf.scene;
    template.scale.setScalar(3);
    template.traverse(o=>{
      if (o.isMesh){
        o.castShadow = o.receiveShadow = true;
        o.material.toneMapped = false;
      }
    });

    // measure it
    template.updateWorldMatrix(true, true);
    const localBBox = new THREE.Box3().setFromObject(template);
    const size      = new THREE.Vector3().subVectors(localBBox.max, localBBox.min);

    // the playfield is -250, 250
    const mapHalf = 250;

    // helper that clones, moves, records a collider and adds to scene
    const addForestWall = (pos, rotY)=>{
        const clone = template.clone(true);
        clone.position.copy(pos);
        clone.rotation.y = rotY || 0;
        this.scene.add(clone);

        // collider
        const box = new THREE.Box3().setFromObject(clone).expandByScalar(0.5);
        this.staticColliders.push(box);
    };

    // south
    addForestWall(
        new THREE.Vector3(-mapHalf - localBBox.min.x, 0, mapHalf - localBBox.min.x),
        0);


    addForestWall(
        new THREE.Vector3(mapHalf - localBBox.max.x, 0, mapHalf - localBBox.min.x),
        0);


    // north
    addForestWall(
        new THREE.Vector3(-mapHalf - localBBox.min.x, 0, 2*(- mapHalf + localBBox.min.x)),
        0);
        
    addForestWall(
        new THREE.Vector3(mapHalf - localBBox.max.x, 0, 2*(- mapHalf + localBBox.min.x)),
        0);

    // west
    addForestWall(
        new THREE.Vector3(-2*mapHalf - localBBox.min.x, 0, -mapHalf - localBBox.min.x),
        0);

    addForestWall(
        new THREE.Vector3(-2*mapHalf - localBBox.min.x, 0,  mapHalf - localBBox.max.x),
        0);

    // east
    addForestWall(
        new THREE.Vector3(2*mapHalf - localBBox.max.x, 0, -mapHalf - localBBox.min.x),
        0);

    addForestWall(
        new THREE.Vector3(2*mapHalf - localBBox.max.x, 0,  mapHalf - localBBox.max.x),
        0);


    // south east corner
    addForestWall(
        new THREE.Vector3(-2*mapHalf, 0, mapHalf - localBBox.min.x),
        0);

    // south west corner
    addForestWall(
        new THREE.Vector3(mapHalf, 0, mapHalf),
        0);

    // north west corner
    addForestWall(
        new THREE.Vector3(mapHalf, 0, -2*mapHalf),
        0);

    // north east corner
    addForestWall(
        new THREE.Vector3(-2*mapHalf, 0, -2*mapHalf),
        0);


  }

  async loadStaticFarm () {
    const gltf = await new GLTFLoader(loadingMgr)
          .setPath('assets/farm/')
          .loadAsync('scene.gltf');

    const root = gltf.scene;
    root.scale.setScalar(10);            // tune size
    root.position.set(50, 0, 30);      // pick a clear spot
    root.traverse(o => {
      if (o.isMesh) {
        o.castShadow = o.receiveShadow = true;
        o.material.toneMapped = false;
      }
    });

    this.scene.add(root);
    // add a collider:
    this.staticColliders.push(new THREE.Box3().setFromObject(root));
  }


  async loadStaticVehicles () {

    const loadTemplate = async (folder, file) =>
      (await new GLTFLoader(loadingMgr).setPath(folder).loadAsync(file)).scene;

    /* load both prefabs once */
    const carTemplate = await loadTemplate(
      'assets/car_apocalyptic_free_gameready_pbr_lowpoly_model/','scene.gltf');
    const vanTemplate = await loadTemplate(
      'assets/van_realistic_abandoned_pbr_low_poly/',        'scene.gltf');

    /* tidy defaults shared by both prefabs */
    const prep = (obj)=>obj.traverse(o=>{
      if (o.isMesh){
        o.castShadow = o.receiveShadow = true;
        o.material.toneMapped = false;
      }
    });
    prep(carTemplate); prep(vanTemplate);

    /* internal util ---------------------------------------------------- */
    const placeAt = (template, pos, scale, rotation)=>{
      const clone = template.clone(true);
      clone.scale.setScalar(scale);
      clone.rotation.y = rotation ?? Math.random() * Math.PI * 2; // random heading is fine if rotation is not specified
      clone.position.copy(pos);

      /* collision safety check */
      const tmpBox = new THREE.Box3().setFromObject(clone);
      const farFromPlayer = pos.clone().setY(0)
                            .distanceToSquared(this.playerSpawnPos) >
                            this.reservedRadiusSq;
      const overlaps = !farFromPlayer ||
                      this.staticColliders.some(b=>b.intersectsBox(tmpBox));
      if (overlaps) return console.warn('Vehicle skipped – overlaps something',pos);

      this.scene.add(clone);
      this.staticColliders.push(tmpBox.clone());
    };

    const CAR_SPAWNS = [
      new THREE.Vector3(80, 0, -60),
    ];

    const VAN_SPAWNS = [
      new THREE.Vector3(160, 0, -60),
    ];

    // actually place them 
    CAR_SPAWNS.forEach(p => placeAt(carTemplate, p, 4, -90));
    VAN_SPAWNS.forEach(p => placeAt(vanTemplate, p, 5, -90));
  }

  async loadStaticRocks () {
    // ───── load the source mesh once ───────────────────────────────────
    const gltfLoader = new GLTFLoader(loadingMgr)
      .setPath('assets/rock/free_pack_-_rocks_stylized/');
    const { scene: rockTemplate } = await gltfLoader.loadAsync('scene.gltf');

    /* nicer defaults */
    rockTemplate.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.material.toneMapped = false;
      }
    });

    // ───── parameters you can tweak ────────────────────────────────────
    const rockCount    = 15;        // how many you want
    const minScale     = 1;         // smallest rock
    const maxScale     = 10;        // biggest rock
    const mapHalfSize  = 250;       // ground is 500×500 → half-extent
    const maxAttempts  = 40;        // tries per rock before we give up

    // ───── helper so we do it once per loop - no GC churn ──────────────
    const tmpBox = new THREE.Box3();

    for (let n = 0; n < rockCount; n++) {

      let placed = false;

      // try several random positions until one fits
      for (let attempt = 0; attempt < maxAttempts && !placed; attempt++) {

        // 1. clone and randomise
        const rock = rockTemplate.clone(true);

        // const s = THREE.MathUtils.lerp(minScale, maxScale, Math.random()); // this is uniformly distributed
        
        // to bias the scale towards smaller rocks
        // the distribution stays in [0, 1] but spends a lot more time near 0 with the cube
        const t = Math.random() ** 3;                // 0‥1 but biased to 0
        const s = THREE.MathUtils.lerp(minScale, maxScale, t);
        rock.scale.setScalar(s);
        rock.rotation.y = Math.random() * Math.PI * 2;

        rock.position.set(
          THREE.MathUtils.randFloatSpread(mapHalfSize * 2),
          0,
          THREE.MathUtils.randFloatSpread(mapHalfSize * 2)
        );

        // 2. compute its bounding box in world space
        rock.updateWorldMatrix(true, true);
        tmpBox.setFromObject(rock);

        // keep clear of the player spawn pad
        const clearOfPlayer = rock.position.clone().setY(0).distanceToSquared(this.playerSpawnPos) > this.reservedRadiusSq;

        const overlapsSomething = !clearOfPlayer || this.staticColliders.some(b => b.intersectsBox(tmpBox));

        if (!overlapsSomething) {
          this.scene.add(rock);
          this.staticColliders.push(tmpBox.clone());
          placed = true;
        }

      }
      // (optional) we could log if a rock couldn’t be placed after many tries
    }
  }

  async loadStaticFences () {

    const gltfLoader = new GLTFLoader(loadingMgr)
        .setPath('assets/old_fence/');            // <-- your folder
    const { scene: fenceTemplate } =
          await gltfLoader.loadAsync('scene.gltf');

    /* nice defaults */
    fenceTemplate.traverse(o=>{
      if (o.isMesh){
        o.castShadow = true;
        o.receiveShadow = true;
        o.material.toneMapped = false;
      }
    });

    /* ─── parameters you can tweak ───────────────────────── */
    const fenceCount   = 5;        // how many pieces
    const fenceScale   = 8;         // **fixed** size multiplier
    const mapHalfSize  = 250;       // same ground half-extent
    const maxAttempts  = 40;        // tries per fence before giving up

    const tmpBox = new THREE.Box3();

    for (let n = 0; n < fenceCount; n++) {

      let placed = false;

      for (let attempt = 0; attempt < maxAttempts && !placed; attempt++) {

        const fence = fenceTemplate.clone(true);

        /* ---- fixed size & random orientation/position ---- */
        fence.scale.setScalar(fenceScale);
        fence.rotation.y = Math.random() * Math.PI * 2;
        fence.position.set(
          THREE.MathUtils.randFloatSpread(mapHalfSize * 2), // x
          0,
          THREE.MathUtils.randFloatSpread(mapHalfSize * 2)  // z
        );

        fence.updateWorldMatrix(true, true);
        tmpBox.setFromObject(fence);

        /* stay clear of player-spawn zone */
        const clearOfPlayer =
          fence.position.clone().setY(0)
              .distanceToSquared(this.playerSpawnPos) > this.reservedRadiusSq;

        const overlaps = !clearOfPlayer ||
                        this.staticColliders.some(b => b.intersectsBox(tmpBox));

        if (!overlaps) {
          this.scene.add(fence);
          this.staticColliders.push(tmpBox.clone());   // store copy
          placed = true;
        }
      }
    }
  }

  initPathfinding() {
    // const mapCells = 200;             // 200×200 => 1000 m² if cell = 5 m
    // const cellSize = 5;               // world metres per cell
    const mapCells = 250;
    const cellSize = 2;
    this.pathfinder = new GridPathFinder(mapCells, mapCells, cellSize);
    // this.pathfinder.showGrid(this.scene)

    const padding = 0;
    for (const box of this.staticColliders) {
      // make a _copy_ so you don’t permanently warp your real bounding boxes
      const padded = box.clone();
      if (padding > 0) {
        const padded = box.clone().expandByScalar(padding);
      }
      this.pathfinder.addCollider(padded);
    }

    // this.pathfinder.drawObstacles(this.scene);
  }

  initEnemySpawner() {
    // Enemy spawner to handle enemy creation.
    this.enemySpawner = new EnemySpawner(
      this.scene, 
      this.player, 
      this,
      this.pathfinder
    );
  }

  initGameState() {

    // Create the player
    this.player = new Player(this.scene, this.camera);
    this.player.game = this; // So player can access game and UI
    this.scene.add(this.player.mesh);

    // Set up a callback so that when the player’s knife attack reaches its hit moment,
    // we check for nearby enemies and apply damage.
    this.player.onKnifeHit = (damage) => {
      const knifeRange = 10; // Define your knife range.
      
      // Compute the player's forward direction (assuming local forward is -Z).
      const forward = new THREE.Vector3(0, 0, 1);
      forward.applyQuaternion(this.player.mesh.quaternion).normalize();
      
      this.enemySpawner.enemies.forEach(enemy => {
        // Compute the vector from the player to the enemy.
        const toEnemy = enemy.mesh.position.clone().sub(this.player.mesh.position);
        const distance = toEnemy.length();
        
        if (distance < knifeRange) {
          // Normalize to get the direction.
          toEnemy.normalize();
          // Check if the enemy is in front of the player.
          if (forward.dot(toEnemy) > 0) { // dot > 0 means enemy is in front.
            const enemyDead = enemy.takeDamage(damage);
            if (enemyDead) {
              // Remove enemy from scene if health reaches 0
              this.enemySpawner.removeEnemy(enemy);
            }
            else {
              const knockback = damage * 0.5;   // impulse magnitude
              const knockbackDir = toEnemy.clone();
              // this will ensure the knockback is purely horizontal
              // this is needed because the player is higher than the enemy
              // so when the he hits him the knockback has a vertical component
              // however, I didn't implement the collision detection
              // with the ground, so the enemy would have sunk
              // under the ground mesh. 
              // That means that this knockback is not respecting 100%
              // the laws of physics, since we are arbitrarily removing
              // the vertical component of the knockback direction. 
              // However, it is a good approximation and no ones cares. 
              knockbackDir.y = 0;
              knockbackDir.normalize();

              enemy.velocity.add( // Δv = J / m
                knockbackDir.multiplyScalar(knockback / enemy.mass)
              );
            }
          }
        }
      });
    };
    
    // Create the UI
    this.turretTokens = 1900;          // how many the player can still place
    this.molotovTokens = 1000;        // give player a few to start

    this.ui = new UI();
    this.ui.updateTurretCount(this.turretTokens);   // initial 0
    this.ui.updateMolotovCount(this.molotovTokens); // initial 3
    this.ui.camera = this.camera;
    
    this.ui.setAvatar('assets/ui/avatar.png');
    
    // Create the Minimap
    this.minimap = new Minimap(1000 /* ground size */, 160 /* px */);


    // Create whatever
    this.pickups = [];
    this.turrets = [];
    this.molotovs      = [];       // active instances
    this.draggingMolotov = null;   // {img, ghost}
    this._activePotion = null;

  }

  registerEventListeners() {

    // Create an input object to track key states.
    this.input = {};

    // Listen for window resize.
    window.addEventListener('resize', () => this.onWindowResize(), false);

    // Listen for mouse clicks to shoot.
    //this.container.addEventListener('click', (event) => this.onMouseClick(event));

    this.isRMBPanning = false;        // are we currently panning? (RMB = Right Mouse Button)
    this.panPrev      = new THREE.Vector2(); // last mouse pos while panning
    this.pixelsToWorld = 0.12;        // ⇢ tune speed (px → world-units)

    window.addEventListener('mousemove', e => {
            
      if (this.isRMBPanning) {

        // 1px  ≙  this.pixelsToWorld  world-units  (keep your existing scalar)
        const scale = this.pixelsToWorld;

        /* camera basis on the XZ plane ------------------------------------- */
        const yUp     = new THREE.Vector3(0, 1, 0);
        const forward = new THREE.Vector3();           // camera -Z
        this.camera.getWorldDirection(forward);
        forward.y = 0; forward.normalize();            // flatten to ground

        const right = new THREE.Vector3()
                        .crossVectors(forward, yUp)    // F × Y = R
                        .normalize();

        /* mouse delta ------------------------------------------------------- */
        const dxPx = e.clientX - this.panPrev.x;       // +X  → screen right
        const dyPx = e.clientY - this.panPrev.y;       // +Y  → screen down
        this.panPrev.set(e.clientX, e.clientY);

        /* map to world space ----------------------------------------------- */
        const move = new THREE.Vector3()
                      .addScaledVector(right,   -dxPx * scale)   // drag → world-right
                      .addScaledVector(forward,  dyPx * scale);  // drag down → world-forward

        if (!this.cameraFollow) {
          this.fixedCameraCenter.add(move)
        }
      }

      this.panPrev.set(e.clientX, e.clientY);

    });

    this.draggingTurret   = null;   // { img, ghost } when user is dragging
  
    this.panCursor = 'grab'; // standard cursor for panning
    this.defaultCursor = this.container.style.cursor || 'auto';

    this.container.addEventListener('mousedown', (event) => {
      if (event.button === 0) { // Left click
        if (this.draggingTurret || this.draggingMolotov) return; // Don't attack while dragging
        this.input['MouseLeft'] = true;
      }
      if (event.button === 2) {            // RMB → start panning

        if (!this.cameraFollow) {
          this.isRMBPanning = true;
          this.panPrev.set(event.clientX, event.clientY);
          this.container.style.cursor = this.panCursor;    // ⬅️ change cursor
          event.preventDefault();                          // no context-menu
        }
      }
    });
    this.container.addEventListener('mouseup', (event) => {
      if (event.button === 0) {
        this.input['MouseLeft'] = false;
      }
      if (event.button === 2) {
        this.isRMBPanning = false;
        this.container.style.cursor = this.defaultCursor; // ⬅️ restore
      }
    });

    // safety net, reset the cursor if the mouse leaves the canvas
    this.container.addEventListener('mouseleave', () => {
      if (this.isRMBPanning) {
        this.isRMBPanning = false;
        this.container.style.cursor = this.defaultCursor;
      }
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault()); // extra safety

    // Listen for keydown and keyup events.
    window.addEventListener('keydown', (event) => {
      this.input[event.code] = true;

      /* Allow restart when the game is over */
      if (this.isGameOver && event.code === 'KeyR') {
        window.location.reload();   // simplest full reset
        return;
      }

      // Spells: 1 = turret, 2 = molotov (you can expand to 3, 4 later)
      switch (event.code) {
        case 'Digit1':
          this.cancelActiveDrag();
          this.ui.onStartTurretDrag?.();
          this.simulatePointerMoveAtMouse(); // trigger ghost placement
          break;
        case 'Digit2':
          this.cancelActiveDrag();
          this.ui.onStartMolotovDrag?.();
          this.simulatePointerMoveAtMouse();
          break;
        case 'Digit3':
          Potion.tryConsume(this);
          break;
        case 'Digit4':
          break;
        case 'KeyC': // toggle camera follow mode
          this.ui.cameraToggleBtn.click();
          break;
        case 'KeyP':
          this.togglePause();
          break;
      }
    });
    window.addEventListener('keyup', (event) => {
      this.input[event.code] = false;
    });

    /* ───── Mouse-wheel zoom ───────────────────────────────────── */
    /*  Aim: keep the same elevation angle ➜  scale distance & height together */

    // values you already have
    this.zoomMin  = 1;   // 0.5  → world looks bigger (zoom-in)
    this.zoomMax  = 2.0;   // 2.0  → world looks smaller (zoom-out)
    this.zoomStep = 0.85;  // wheel “notch” scale

    this.container.addEventListener('wheel', e => {
      e.preventDefault();

      const dir    = Math.sign(e.deltaY);           // -1 up   (zoom-in)
                                                    //  1 down (zoom-out)
      const factor = dir < 0 ? this.zoomStep : 1 / this.zoomStep;

      // clamp zoom so it never goes outside the limits
      this.camera.zoom = THREE.MathUtils.clamp(
        this.camera.zoom * factor,
        this.zoomMin,
        this.zoomMax
      );

      this.camera.updateProjectionMatrix();         // <-- IMPORTANT
    });


    /* ---------- DRAG-TO-PLACE TURRET ---------------------------------- */
    this.turretPrefab     = null;   // loaded once, then cloned for the ghost

    this.ui.onStartTurretDrag = () => {
      if (this.turretTokens <= 0) {
        return;
      }
      this.cancelActiveDrag();
      /* 1. create the little icon that follows the cursor (UI only) */
      const img = this.ui.turretBtn.cloneNode();
      img.style.cssText = `
        position:absolute; width:48px; height:48px; opacity:.7;
        pointer-events:none; transform:translate(-24px,-24px);`;
      document.body.appendChild(img);

      /* 2. create / clone a translucent green “ghost” in 3-D */
      let ghost;
      if (this.turretPrefab) {
        ghost = this.turretPrefab.clone(true);
        ghost.traverse(o => {
          if (o.isMesh) {
            o.material = o.material.clone();
            o.material.color.set(0x00ff00);
            o.material.opacity = 0.5;
            o.material.transparent = true;
            o.material.depthWrite = false;
          }
        });
      } else {
        /* fallback: simple cylinder if the model hasn’t loaded yet */
        ghost = new THREE.Mesh(
          new THREE.CylinderGeometry(1.5, 1.5, 2, 24),
          new THREE.MeshBasicMaterial({ color:0x00ff00, opacity:0.5, transparent:true })
        );
      }

      /* ───── add a range circle under that ghost ───── */
      const RANGE_SQ = 5000;                        // same value as turret.range
      const radius   = Math.sqrt(RANGE_SQ);         // convert to metres
          
      // thin ring looks nicer than a filled disc
      const ringGeo = new THREE.RingGeometry(radius * 0.93, radius, 64); // inner, outer
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        transparent: true,
        opacity: 0.4,
        depthWrite: false       // never cut into the ground
      });
      const rangeRing = new THREE.Mesh(ringGeo, ringMat);
      rangeRing.rotation.x = -Math.PI / 2;          // lie flat
      rangeRing.position.y = 0.03;                  // lift a hair → avoid z-fighting
      ghost.add(rangeRing);
      /* ───────────────────────────────────────────────────── */
      this.scene.add(ghost);

      this.draggingTurret = { img, ghost };
    };

    window.addEventListener('pointermove', e => {
      if (!this.draggingTurret) return;

      /* move UI icon */
      this.draggingTurret.img.style.left = `${e.clientX}px`;
      this.draggingTurret.img.style.top  = `${e.clientY}px`;

      /* move 3-D ghost */
      const rect = this.renderer.domElement.getBoundingClientRect();
      const ndc  = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width ) * 2 - 1,
        ((e.clientY - rect.top )  / rect.height) * -2 + 1
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);

      const ground = new THREE.Plane(new THREE.Vector3(0,1,0), 0);      // y = 0
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(ground, hit)) {
        /* optional grid-snap */
        const grid = 2;  // size of your tiles
        hit.set(
          Math.round(hit.x / grid) * grid,
          0,
          Math.round(hit.z / grid) * grid
        );
        this.draggingTurret.ghost.position.copy(hit);
      
        // validate and recolor
        const ok = this.isTurretPlacementValid(hit);
        this.draggingTurret.ghost.traverse(o=>{
          if (o.isMesh && o.material){
            o.material.color.set( ok ? 0x00ff00 : 0xff3333 );
          }
        });
        // the ring uses its own material – tint it to match
        if (this.draggingTurret.rangeRing) {
          this.draggingTurret.rangeRing.material.color
                .set(ok ? 0x00ff00 : 0xff3333);
        }
      }
    });

    window.addEventListener('pointerup', e => {
      if (!this.draggingTurret) return;

      const pos = this.draggingTurret.ghost.position.clone();
      const ok  = !isNaN(pos.x) && this.isTurretPlacementValid(pos);
      const turretCost = 50;
      if (ok && this.player.spendMana(turretCost)) {
        const turret = new Turret(
          pos.clone(),
          this.scene,
          this.enemySpawner,
          this.bullets
        );
        this.turrets.push(turret);

        this.addTurretToken(-1);              // spend one token & refresh badge
      } else if (!ok) {
        this.ui.showFloatingMessage("❌ Can't place turret here!", pos);
      }

      /* clean up */
      this.scene.remove(this.draggingTurret.ghost);
      document.body.removeChild(this.draggingTurret.img);
      this.draggingTurret = null;
    });
    /* --------------------------------------------------------------- */


    /* ---------- DRAG-TO-PLACE MOLOTOV -------------------------------- */
    this.ui.onStartMolotovDrag = () => {
      if (this.molotovTokens <= 0) return;
      this.cancelActiveDrag();
      /* tiny cursor ghost – reuse turret icon style */
      const img = this.ui.molotovBtn.cloneNode();
      img.style.cssText = `
          position:absolute;width:48px;height:48px;opacity:.8;
          pointer-events:none;transform:translate(-24px,-24px);`;
      document.body.appendChild(img);

      /* 3-D ghost: just a red circle */
      const ghost = new THREE.Mesh(
          new THREE.CircleGeometry(4,32),
          new THREE.MeshBasicMaterial({color:0xff3300,opacity:0.4,
                                      transparent:true,depthWrite:false}));
      ghost.rotation.x = -Math.PI/2;
      this.scene.add(ghost);

      this.draggingMolotov = {img,ghost};
    };

    /* pointermove identical to turret logic but writing into draggingMolotov */
    window.addEventListener('pointermove',e=>{
      if(!this.draggingMolotov) return;
      const {img,ghost}=this.draggingMolotov;
      img.style.left=`${e.clientX}px`; img.style.top=`${e.clientY}px`;

      const rect=this.renderer.domElement.getBoundingClientRect();
      const ndc=new THREE.Vector2(
            ((e.clientX-rect.left)/rect.width)*2-1,
            ((e.clientY-rect.top )/rect.height)*-2+1);
      const ray=new THREE.Raycaster(); ray.setFromCamera(ndc,this.camera);
      const ground=new THREE.Plane(new THREE.Vector3(0,1,0),0);
      const hit=new THREE.Vector3();
      if(ray.ray.intersectPlane(ground,hit)){
          const grid=2;
          hit.set(Math.round(hit.x/grid)*grid,0,
                  Math.round(hit.z/grid)*grid);
          ghost.position.copy(hit);
      }
    });

    window.addEventListener('pointerup', async e => {

      /* no drag in progress? */
      if (!this.draggingMolotov) return;

      /* unpack & remember where the ghost ended up ------------------ */
      const { img, ghost } = this.draggingMolotov;
      const dropPos = ghost.position.clone();   // store before we delete it!

      /* --- 1.  IMMEDIATE CLEAN-UP ---------------------------------- */
      this.scene.remove(ghost);                 // stop rendering
      ghost.geometry.dispose();                 // free GPU memory
      ghost.material.dispose();
      document.body.removeChild(img);           // remove cursor icon
      this.draggingMolotov = null;              // reset state

      // /* --- 2.  If we still have a token, spawn a Molotov ------------ */
      const molotovCost = 50;
      if (!isNaN(dropPos.x) && this.player.spendMana(molotovCost)) {
        const { Molotov } = await import('./Molotov.js');
        const m = new Molotov(dropPos, this.scene, this.camera, this);
        this.molotovs.push(m);
        this.addMolotovToken(-1);
      }
    });
    /* ----------------------------------------------------------------- */

    this.ui.onToggleCameraFollow = () => {
      this.cameraFollow = !this.cameraFollow;
      
      if (!this.cameraFollow) {
        /* turning FOLLOW → FIXED
            remember the spot where we’ll keep looking,
            and stop the spring motion */
        this.fixedCameraCenter.copy(this.player.mesh.position);
        this.cameraVel.set(0, 0, 0);
      }
    
      this.ui.showFloatingMessage(
        "Camera " + (this.cameraFollow ? "Following" : "Fixed"),
        this.player.mesh.position.clone()
      );
    };
  }

  cancelActiveDrag() {
    /* ─ Turret drag ─ */
    if (this.draggingTurret) {
      this.scene.remove(this.draggingTurret.ghost);
      document.body.removeChild(this.draggingTurret.img);
      this.draggingTurret = null;
    }
    /* ─ Molotov drag ─ */
    if (this.draggingMolotov) {
      this.scene.remove(this.draggingMolotov.ghost);
      this.draggingMolotov.ghost.geometry?.dispose?.();
      this.draggingMolotov.ghost.material?.dispose?.();
      document.body.removeChild(this.draggingMolotov.img);
      this.draggingMolotov = null;
    }
  }

  simulatePointerMoveAtMouse() {
    const evt = new PointerEvent('pointermove', {
      clientX: this.panPrev.x,
      clientY: this.panPrev.y
    });
    window.dispatchEvent(evt);
  }

  // Game.js – just under the constructor
  addTurretToken(count = 1, worldPos = null) {
    this.turretTokens += count;
    this.ui.updateTurretCount(this.turretTokens);

    const pos = worldPos ?? this.player.mesh.position.clone();
    this.ui.showFloatingMessage(`🛡️ +${count} Turret`, pos);
  }

  addMolotovToken(count=1, worldPos=null){
    this.molotovTokens += count;
    this.ui.updateMolotovCount(this.molotovTokens);
    const pos = worldPos ?? this.player.mesh.position.clone();
    this.ui.showFloatingMessage(`🔥 +${count} Molotov`, pos);
  }

  activateBulletHell() {
    this.bulletHellActive = true;
    this.bulletHellTimer = this.bulletHellDuration;
    this.ui.showFloatingMessage(
      "🔥 BULLET HELL! 🔥",
      this.player.mesh.position.clone(),
      { fontSize: 'px', color: 'red', duration: 3 }
    );
  }


  activateKnifeSpeedPowerupThree() {
    this.knifeSpeedPowerupActive = true;
    this.knifeSpeedPowerupTimer = this.knifeSpeedPowerupDuration;
    // Display a message on screen.
    this.ui.showFloatingMessage("⚡ Knife Speed Powerup Activated!", this.player.mesh.position.clone());
  }
  
  
  activateAttackVelocityBuff() {
    this.attackVelocityBuffActive = true;
    this.attackVelocityBuffTimer = this.attackVelocityBuffDuration;
    // Display a message on the screen.
    this.ui.showFloatingMessage("⚡ Knife Buff!", this.player.mesh.position.clone());
  }  

  onWindowResize() {
    const aspect = this.container.clientWidth / this.container.clientHeight;
    const viewSize = 100; // Same value as before
    this.camera.left = -viewSize * aspect / 2;
    this.camera.right = viewSize * aspect / 2;
    this.camera.top = viewSize / 2;
    this.camera.bottom = -viewSize / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }
  
  onMouseClick(event) {
    // Calculate normalized device coordinates (NDC)
    if (this.draggingTurret || this.draggingMolotov) return; // Don't shoot while dragging
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    // Set up a raycaster from the camera through the mouse position.
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);

    // Intersect with a horizontal plane at y = 0.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const intersectionPoint = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, intersectionPoint);

    if (intersectionPoint) {
      const direction = intersectionPoint.sub(this.player.mesh.position).normalize();
      const bullet = new Bullet(this.player.mesh.position.clone(), direction, this.scene);
      // Add the player's current velocity to the bullet.
      bullet.velocity.add(this.player.velocity);
      // Apply buff: increase bullet speed if the buff is active.
      if (this.attackVelocityBuffActive) {
        bullet.velocity.multiplyScalar(this.attackVelocityBuffMultiplier);
      }
      this.bullets.push(bullet);
      this.scene.add(bullet.mesh);
    }
  }

  start() {
    this.animate();
  }


  onPlayerDeath() {
    if (this.isGameOver) return;      // already handled
 
    this.isGameOver = true;
    
    /* Freeze all enemies & animations -------------------------------- */
    this.enemySpawner?.pause?.();     // only if you added a pause() method
    this.turrets.forEach(t => t.active = false); 

     /* spotlight over the body ------------------------------------- */
    const spot = new THREE.SpotLight(0xffffff, 2, 60, Math.PI/7, .5, 1);
    spot.position.set(
      this.player.mesh.position.x,
      40,
      this.player.mesh.position.z
    );
    spot.target = this.player.mesh;
    this.scene.add(spot, spot.target);

    /* Immediately dim everything else — two tricks combined:
    lower global lights, translucent overlay */
    if (this.ambientLight)     this.ambientLight.intensity   = 0.05;
    if (this.directionalLight) this.directionalLight.intensity = 0.05;
    this.ui.dimStage();        // quick CSS overlay (doesn’t mute the spot)


    /* after two seconds start fading to black --------------------- */
    setTimeout(() => {
      this.ui.fadeToBlack(()=>{
        /* show GAME OVER panel ------------------------------------ */
        const wave  = this.enemySpawner?.currentWave ?? 0;
        const ms    = performance.now() - this.sessionStart;
        const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000);
        const timeStr = `${m}:${s.toString().padStart(2,'0')}`;
        this.ui.showGameOver(wave, timeStr);
      });

    }, 2000);

  }

  animate() {

    requestAnimationFrame(() => this.animate());
    
    const delta = this.clock.getDelta();

    // is the game paused? Don't update anything, just re-render the current frame.
    if (this.paused) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // GAME OVER? Don't update anything.
    if (this.isGameOver) {
      this.renderer.render(this.scene, this.camera); // still draw spotlight
      return;                                        // skip all gameplay
    }

    // wait until the player mesh has been loaded
    if (!this.player.mesh) {          // still null? Skip logic this frame
      return;
    }

    // -------------------------- UPDATE PLAYER --------------------------
    this.player.update(delta, this.input, this.cameraAngle);
    // ---------------------- END UPDATE PLAYER --------------------------

    // --------------------------- UPDATE LIGHTS --------------------------
    // Make the sunlight follow the action so its 600 x 600 m box 
    //is always centred on the player
    const l = this.directionalLight;
    const p = this.player.mesh.position;
    const offset = new THREE.Vector3(200, 140, 200);   // same as in initLights
    l.position.copy(p).add(offset);                    // move the light
    l.target.position.copy(p);                         // look at player
    l.target.updateMatrixWorld();
    // ---------------------- END UPDATE LIGHTS --------------------------

    // --------------------------- UPDATE ENEMIES --------------------------
    if (this.enemySpawner) {
      // Update the enemy spawner
      this.enemySpawner.update(delta);
      // Update each enemy and check for enemy attacks
      for (let enemy of this.enemySpawner.enemies) {
        enemy.update(delta, this.camera);

        if (enemy.isAttacking && enemy.attackAction) {
          // Check if the attack animation has looped:
          // If the current attack action time is less than the last recorded time,
          // it means a new cycle has started.
          if (enemy.attackAction.time < enemy.lastAttackCycleTime) {
            enemy.hasDamaged = false;
          }
          enemy.lastAttackCycleTime = enemy.attackAction.time;
      
          // Define the coverage area for the enemy's attack.
          const attackRange = 5;
          const distance = enemy.mesh.position.distanceTo(this.player.mesh.position);
      
          // If the player is within the attack range and damage hasn't been applied for this cycle:
          if (distance < attackRange && !enemy.hasDamaged) {
            this.player.takeDamage(10);
            enemy.hasDamaged = true;
          }
        } else {
          // Reset the damage flag when the enemy is not in attack state.
          enemy.hasDamaged = false;
        }
      }
    }
    // ----------------------- END UPDATE ENEMIES --------------------------
    
    // --------------------------- UPDATE BULLETS --------------------------
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      bullet.update(delta);

      // Check collision between this bullet and all enemies.
      for (let j = this.enemySpawner.enemies.length - 1; j >= 0; j--) {
        const enemy = this.enemySpawner.enemies[j];
        // Calculate collision based on the sum of radii.
        const collisionDistance = bullet.radius + enemy.radius;
        const distance = bullet.mesh.position.distanceTo(enemy.mesh.position);
        if (distance < collisionDistance) {
          // kinetic energy E = ½ m v²  (use v² = |v|² to avoid a sqrt) for bullet damage calculation
          const energy  = 0.5 * bullet.mass * bullet.velocity.lengthSq();
          const baseDmg = energy * 0.02;
          const dmg     = bullet.damage ?? baseDmg; // if power-ups set bullet.damage, use that
          const enemyDead = enemy.takeDamage(dmg);
          if (enemyDead) {
            // Remove enemy from scene if health reaches 0.
            this.enemySpawner.removeEnemy(enemy);
          }
          // Remove the bullet after it hits.
          this.scene.remove(bullet.mesh);
          this.bullets.splice(i, 1);
          break;
        }
      }
    }
    // ------------------------- END UPDATE BULLETS --------------------------

    // --------------------------- UPDATE PICKUPS --------------------------
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const heart = this.pickups[i];
      const collected = heart.update(delta);
      if (collected) {
        this.scene.remove(heart.mesh);
        heart.destroy(this.scene);
        this.pickups.splice(i, 1);
        this.ui.showFloatingMessage("+20 HP 💖", this.player.mesh.position.clone());
      }      
    }
    // ------------------------- END UPDATE PICKUPS --------------------------

    // --------------------------- UPDATE UI --------------------------
    this.ui.update(this.enemySpawner?.currentWave ?? 0);
    // ------------------------- END UPDATE UI --------------------------
    

    // --------------------------- UPDATE CAMERA --------------------------
    const rotationSpeed = 1.0; // Radians per second

    if (this.input['KeyQ']) {
      // Rotate camera to the left.
      this.cameraAngle -= delta * rotationSpeed;
    }
    if (this.input['KeyE']) {
      // Rotate camera to the right.
      this.cameraAngle += delta * rotationSpeed;
    }
    
    // Position the camera based on follow mode.
    if (this.cameraFollow && this.player.mesh) {
      /*------------------------------------------------------------
        Spring-damper camera smoothing
        x  = camera.position          (current state)
        xₜ = target                   (where we’d like the camera to be)
        v  = this.cameraVel           (velocity we integrate each frame)
    
        a = –k(x‒xₜ) – c v            (Hooke’s law + damping)
        v += a Δt
        x += v Δt
      ------------------------------------------------------------*/
    
      // where should the camera eventually sit?
      const target = this.player.mesh.position.clone().add(
        new THREE.Vector3(
          this.cameraDistance * Math.cos(this.cameraAngle),
          this.cameraHeight,
          this.cameraDistance * Math.sin(this.cameraAngle)
        )
      );
    
      // spring parameters 
      const k = 12;    // stiffness  (how aggressively it pulls)
      const c = 8;     // damping    (how much it resists oscillation)
    
      // acceleration = spring + damping
      const camAcc = target.clone().sub(this.camera.position).multiplyScalar(k)
                      .add(this.cameraVel.clone().multiplyScalar(-c));
    
      // semi-implicit Euler integrate
      this.cameraVel.addScaledVector(camAcc, delta);       // v ← v + aΔt
      this.camera.position.addScaledVector(this.cameraVel, delta); // x ← x + vΔt
    
      // always look at the player
      this.camera.lookAt(this.player.mesh.position);
    } else {
        // Fixed mode: orbit around the saved centre
        this.camera.position.set(
          this.fixedCameraCenter.x + this.cameraDistance * Math.cos(this.cameraAngle),
          this.fixedCameraCenter.y + this.cameraHeight,
          this.fixedCameraCenter.z + this.cameraDistance * Math.sin(this.cameraAngle)
        );
     this.camera.lookAt(this.fixedCameraCenter);
    }
    // ------------------------- END UPDATE CAMERA --------------------------
    
    
    // --------------------------- UPDATE TURRETS --------------------------
    for (const t of this.turrets) t.update(delta);
    // ------------------------- END UPDATE TURRETS --------------------------

    // --------------------------- UPDATE MOLOTOVS --------------------------
    for(let i=this.molotovs.length-1;i>=0;i--) {
      const m=this.molotovs[i];
      m.enemies = this.enemySpawner.enemies; // each frame, we give to each molotov a fresh list of the enemies
      const dead = m.update(delta);
      if(dead){
        this.molotovs.splice(i,1);
      }
    }
    // ------------------------- END UPDATE MOLOTOVS --------------------------

    // --------------------------- UPDATE POTION --------------------------
    if (this._activePotion && this._activePotion.update(delta)) {
      // if update() returned true the buff expired & cleaned itself
      this._activePotion = null;
    }
    // ------------------------- END UPDATE POTION --------------------------

    // --------------------------- UPDATE PLAYER BARS --------------------------
    this.player.regenMana(delta);
    this.ui.updateManaBar((this.player.mana / this.player.maxMana) * 100);

    this.ui.updatePlayerBars(
      this.player.mesh.position.clone().add(new THREE.Vector3(0, 15, 0)), // this is the head position of the player
      this.player.health,
      (this.player.mana / this.player.maxMana) * 100
    );

    this.ui.updateCenterHUD(
        this.player.health,
        (this.player.mana / this.player.maxMana) * 100,
        null
    );    
    this.ui.updateLevelRing(this.player.level, this.player.xpPct);
    // ------------------------- END UPDATE PLAYER BARS --------------------------


    // --------------------------------- UPDATE MINIMAP --------------------------
    this.minimap.update(
      this.player,
      this.enemySpawner?.enemies ?? [],
      this.pickups,
      this.cameraAngle
    );
    // --------------------------- END UPDATE MINIMAP --------------------------

    // Render the scene.
    this.renderer.render(this.scene, this.camera);
  }
}
