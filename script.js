import * as THREE from 'https://esm.sh/three@0.165.0';
import { OrbitControls } from 'https://esm.sh/three@0.165.0/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'https://esm.sh/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://esm.sh/three@0.165.0/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'https://esm.sh/three@0.165.0/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'https://esm.sh/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GLTFLoader } from 'https://esm.sh/three@0.165.0/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'https://esm.sh/three@0.165.0/examples/jsm/exporters/GLTFExporter.js';
import { DRACOLoader } from 'https://esm.sh/three@0.165.0/examples/jsm/loaders/DRACOLoader.js';

// Signals
const Signals = window.signals ? window.signals.Signal : class Signal {
    constructor() {
        this.listeners = [];
    }
    add(listener) {
        this.listeners.push(listener);
    }
    dispatch(...args) {
        this.listeners.forEach(listener => listener(...args));
    }
};
const signals = {
    objectSelected: new Signals(),
    objectAdded: new Signals(),
    objectRemoved: new Signals(),
    objectChanged: new Signals(),
    materialChanged: new Signals(),
    lightChanged: new Signals(),
    sceneEnvironmentChanged: new Signals(),
    sceneGraphChanged: new Signals(),
    historyChanged: new Signals(),
    windowResize: new Signals(),
    modeChanged: new Signals()
};

// Editor
class Editor {
    constructor() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(5, 5, 5);
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth - 540, window.innerHeight - 72); // Adjusted for panel widths and header/toolbar
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.selected = null;
        this.objects = [];
        this.lights = [];
        this.currentLight = null;
        this.actionHistory = [];
        this.historyIndex = -1;
        this.config = { autosave: true };
        this.storage = {
            get: (callback) => {
                const state = localStorage.getItem('scene');
                if (state) callback(JSON.parse(state));
                else callback(null);
            },
            set: (state) => localStorage.setItem('scene', JSON.stringify(state)),
            init: (callback) => callback()
        };
        this.mode = 'model';
        this.composer = new EffectComposer(this.renderer);
        const renderPass = new RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);
        const contrastShader = {
            uniforms: {
                tDiffuse: { value: null },
                contrast: { value: 1.0 }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform float contrast;
                varying vec2 vUv;
                void main() {
                    vec4 color = texture2D(tDiffuse, vUv);
                    color.rgb = ((color.rgb - 0.5) * contrast) + 0.5;
                    gl_FragColor = color;
                }
            `
        };
        this.contrastPass = new ShaderPass(contrastShader);
        this.composer.addPass(this.contrastPass);
        const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.4, 0.85);
        bloomPass.enabled = false;
        this.composer.addPass(bloomPass);
    }
    
    select(obj) {
        this.selected = obj;
        signals.objectSelected.dispatch(obj);
    }
    
    getObjectState(obj) {
        if (!obj) return null;
        if (obj.isMesh) {
            return {
                type: 'mesh',
                position: obj.position.clone(),
                rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
                scale: obj.scale.clone(),
                material: {
                    type: obj.material.type,
                    color: obj.material.color.getHex()
                }
            };
        } else if (obj.isLight) {
            return {
                type: 'light',
                lightType: obj.type.toLowerCase(),
                position: obj.position.clone(),
                intensity: obj.intensity,
                color: obj.color.getHex()
            };
        }
    }
    
    applyObjectState(obj, state) {
        if (!obj || !state) return;
        if (state.type === 'mesh') {
            obj.position.copy(state.position);
            obj.rotation.set(state.rotation[0], state.rotation[1], state.rotation[2]);
            obj.scale.copy(state.scale);
            if (obj.material.type === state.material.type) {
                obj.material.color.setHex(state.material.color);
            }
        } else if (state.type === 'light') {
            obj.position.copy(state.position);
            obj.intensity = state.intensity;
            obj.color.setHex(state.color);
        }
        signals.objectChanged.dispatch(obj);
    }
    
    addAction(action) {
        this.actionHistory = this.actionHistory.slice(0, this.historyIndex + 1);
        this.actionHistory.push(action);
        this.historyIndex++;
        signals.historyChanged.dispatch();
    }
    
    undo() {
        if (this.historyIndex < 0) return;
        const action = this.actionHistory[this.historyIndex];
        if (action.type === 'add') {
            const obj = this.scene.getObjectById(action.objectId);
            if (obj) {
                this.scene.remove(obj);
                signals.objectRemoved.dispatch(obj);
            }
        } else if (action.type === 'remove') {
            if (action.object) {
                this.scene.add(action.object);
                signals.objectAdded.dispatch(action.object);
            }
        } else if (action.type === 'modify') {
            const obj = this.scene.getObjectById(action.objectId);
            if (obj && action.oldState) {
                this.applyObjectState(obj, action.oldState);
            }
        }
        this.historyIndex--;
        signals.historyChanged.dispatch();
    }
    
    redo() {
        if (this.historyIndex >= this.actionHistory.length - 1) return;
        this.historyIndex++;
        const action = this.actionHistory[this.historyIndex];
        if (action.type === 'add') {
            if (action.object) {
                this.scene.add(action.object);
                signals.objectAdded.dispatch(action.object);
            }
        } else if (action.type === 'remove') {
            const obj = this.scene.getObjectById(action.objectId);
            if (obj) {
                this.scene.remove(obj);
                signals.objectRemoved.dispatch(obj);
            }
        } else if (action.type === 'modify') {
            const obj = this.scene.getObjectById(action.objectId);
            if (obj && action.newState) {
                this.applyObjectState(obj, action.newState);
            }
        }
        signals.historyChanged.dispatch();
    }
    
    addObject(obj) {
        this.scene.add(obj);
        this.objects.push(obj);
        this.addAction({
            type: 'add',
            objectId: obj.id,
            object: obj
        });
        signals.objectAdded.dispatch(obj);
    }
    
    removeObject(obj) {
        const index = this.objects.indexOf(obj);
        if (index !== -1) {
            this.objects.splice(index, 1);
        }
        this.addAction({
            type: 'remove',
            objectId: obj.id,
            object: obj
        });
        this.scene.remove(obj);
        signals.objectRemoved.dispatch(obj);
    }
    
    createPrimitive(type) {
        let geometry, material, mesh;
        
        switch(type) {
            case 'cube':
                geometry = new THREE.BoxGeometry(1, 1, 1);
                break;
            case 'sphere':
                geometry = new THREE.SphereGeometry(0.5, 32, 16);
                break;
            case 'cylinder':
                geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
                break;
            case 'cone':
                geometry = new THREE.ConeGeometry(0.5, 1, 32);
                break;
            case 'torus':
                geometry = new THREE.TorusGeometry(0.5, 0.2, 16, 100);
                break;
            case 'knot':
                geometry = new THREE.TorusKnotGeometry(0.5, 0.2, 100, 16);
                break;
            default:
                geometry = new THREE.BoxGeometry(1, 1, 1);
        }
        
        material = new THREE.MeshStandardMaterial({
            color: 0x5f3dc4,
            metalness: 0.3,
            roughness: 0.4
        });
        
        mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = type.charAt(0).toUpperCase() + type.slice(1) + ' ' + (this.objects.length + 1);
        
        this.addObject(mesh);
        this.select(mesh);
        
        return mesh;
    }
    
    createLight(type) {
        let light;
        
        switch(type) {
            case 'point':
                light = new THREE.PointLight(0xffffff, 1, 50);
                light.position.set(2, 2, 2);
                break;
            case 'directional':
                light = new THREE.DirectionalLight(0xffffff, 1);
                light.position.set(5, 5, 5);
                break;
            case 'spot':
                light = new THREE.SpotLight(0xffffff, 1);
                light.position.set(2, 5, 2);
                light.angle = Math.PI / 6;
                light.penumbra = 0.2;
                break;
            case 'ambient':
                light = new THREE.AmbientLight(0x404040, 1);
                break;
            default:
                light = new THREE.PointLight(0xffffff, 1, 50);
                light.position.set(2, 2, 2);
        }
        
        if (light.isPointLight || light.isDirectionalLight || light.isSpotLight) {
            light.castShadow = true;
            light.shadow.mapSize.width = 1024;
            light.shadow.mapSize.height = 1024;
        }
        
        light.name = type.charAt(0).toUpperCase() + type.slice(1) + ' Light ' + (this.lights.length + 1);
        
        this.lights.push(light);
        this.addObject(light);
        this.select(light);
        
        return light;
    }
    
    setEnvironment(preset) {
        // Clear existing environment
        this.scene.background = new THREE.Color(0x000000);
        
        // Remove existing lights except the selected one
        this.scene.traverse(obj => {
            if (obj.isLight && obj !== this.selected) {
                this.scene.remove(obj);
            }
        });
        
        switch(preset) {
            case 'studio':
                this.scene.background = new THREE.Color(0x111111);
                const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
                this.scene.add(ambientLight);
                
                const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
                keyLight.position.set(5, 10, 7.5);
                keyLight.castShadow = true;
                this.scene.add(keyLight);
                
                const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
                fillLight.position.set(-5, 5, 5);
                this.scene.add(fillLight);
                
                const rimLight = new THREE.DirectionalLight(0xffffff, 0.2);
                rimLight.position.set(0, 5, -10);
                this.scene.add(rimLight);
                break;
                
            case 'sunset':
                this.scene.background = new THREE.Color(0x661100);
                const sunsetAmbient = new THREE.AmbientLight(0xff9966, 0.3);
                this.scene.add(sunsetAmbient);
                
                const sunLight = new THREE.DirectionalLight(0xff7700, 1);
                sunLight.position.set(-10, 5, 10);
                sunLight.castShadow = true;
                this.scene.add(sunLight);
                
                const blueRim = new THREE.DirectionalLight(0x0066ff, 0.2);
                blueRim.position.set(10, 5, -10);
                this.scene.add(blueRim);
                break;
                
            case 'night':
                this.scene.background = new THREE.Color(0x001122);
                const nightAmbient = new THREE.AmbientLight(0x0022ff, 0.1);
                this.scene.add(nightAmbient);
                
                const moonLight = new THREE.DirectionalLight(0x8888ff, 0.5);
                moonLight.position.set(5, 10, -5);
                moonLight.castShadow = true;
                this.scene.add(moonLight);
                break;
                
            case 'forest':
                this.scene.background = new THREE.Color(0x113322);
                const forestAmbient = new THREE.AmbientLight(0x88aa77, 0.5);
                this.scene.add(forestAmbient);
                
                const sunThroughTrees = new THREE.DirectionalLight(0xffcc88, 0.7);
                sunThroughTrees.position.set(3, 10, 5);
                sunThroughTrees.castShadow = true;
                this.scene.add(sunThroughTrees);
                break;
        }
        
        signals.sceneEnvironmentChanged.dispatch();
    }
    
    exportScene() {
        return new Promise((resolve, reject) => {
            const exporter = new GLTFExporter();
            const options = {
                binary: false,
                onlyVisible: true
            };
            
            exporter.parse(this.scene, (result) => {
                if (result instanceof ArrayBuffer) {
                    resolve(new Blob([result], { type: 'application/octet-stream' }));
                } else {
                    resolve(new Blob([JSON.stringify(result)], { type: 'application/json' }));
                }
            }, options);
        });
    }
    
    importModel(file) {
        return new Promise((resolve, reject) => {
            const loader = new GLTFLoader();
            const dracoLoader = new DRACOLoader();
            dracoLoader.setDecoderPath('https://esm.sh/three@0.165.0/examples/jsm/libs/draco/');
            loader.setDRACOLoader(dracoLoader);
            
            const reader = new FileReader();
            reader.onload = (event) => {
                const contents = event.target.result;
                
                loader.parse(contents, '', (gltf) => {
                    const model = gltf.scene;
                    
                    // Process model
                    model.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                    
                    this.addObject(model);
                    resolve(model);
                }, (error) => {
                    reject(error);
                });
            };
            
            if (file.name.toLowerCase().endsWith('.glb')) {
                reader.readAsArrayBuffer(file);
            } else {
                reader.readAsText(file);
            }
        });
    }
    
    saveState() {
        if (!this.config.autosave) return;
        
        const state = {
            objects: this.objects.map(obj => {
                if (obj.isMesh) {
                    return {
                        id: obj.id,
                        type: 'mesh',
                        name: obj.name,
                        position: [obj.position.x, obj.position.y, obj.position.z],
                        rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
                        scale: [obj.scale.x, obj.scale.y, obj.scale.z],
                        material: {
                            color: obj.material.color.getHex(),
                            metalness: obj.material.metalness,
                            roughness: obj.material.roughness,
                            wireframe: obj.material.wireframe
                        }
                    };
                } else if (obj.isLight) {
                    const lightData = {
                        id: obj.id,
                        type: 'light',
                        lightType: obj.type.toLowerCase(),
                        name: obj.name,
                        position: [obj.position.x, obj.position.y, obj.position.z],
                        color: obj.color.getHex(),
                        intensity: obj.intensity
                    };
                    
                    if (obj.isSpotLight) {
                        lightData.angle = obj.angle;
                        lightData.penumbra = obj.penumbra;
                    }
                    
                    return lightData;
                }
                return null;
            }).filter(item => item !== null)
        };
        
        this.storage.set(state);
    }
    
    loadState() {
        this.storage.get((state) => {
            if (!state) return;
            
            // Clear existing objects
            while (this.objects.length > 0) {
                const obj = this.objects[0];
                this.scene.remove(obj);
                this.objects.shift();
            }
            
            // Recreate objects from state
            state.objects.forEach(objData => {
                if (objData.type === 'mesh') {
                    let geometry;
                    
                    // Determine geometry type from name
                    if (objData.name.toLowerCase().includes('cube')) {
                        geometry = new THREE.BoxGeometry(1, 1, 1);
                    } else if (objData.name.toLowerCase().includes('sphere')) {
                        geometry = new THREE.SphereGeometry(0.5, 32, 16);
                    } else if (objData.name.toLowerCase().includes('cylinder')) {
                        geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
                    } else if (objData.name.toLowerCase().includes('cone')) {
                        geometry = new THREE.ConeGeometry(0.5, 1, 32);
                    } else if (objData.name.toLowerCase().includes('torus')) {
                        geometry = new THREE.TorusGeometry(0.5, 0.2, 16, 100);
                    } else if (objData.name.toLowerCase().includes('knot')) {
                        geometry = new THREE.TorusKnotGeometry(0.5, 0.2, 100, 16);
                    } else {
                        geometry = new THREE.BoxGeometry(1, 1, 1);
                    }
                    
                    const material = new THREE.MeshStandardMaterial({
                        color: objData.material.color,
                        metalness: objData.material.metalness,
                        roughness: objData.material.roughness,
                        wireframe: objData.material.wireframe
                    });
                    
                    const mesh = new THREE.Mesh(geometry, material);
                    mesh.name = objData.name;
                    mesh.position.set(objData.position[0], objData.position[1], objData.position[2]);
                    mesh.rotation.set(objData.rotation[0], objData.rotation[1], objData.rotation[2]);
                    mesh.scale.set(objData.scale[0], objData.scale[1], objData.scale[2]);
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    
                    this.scene.add(mesh);
                    this.objects.push(mesh);
                    
                } else if (objData.type === 'light') {
                    let light;
                    
                    switch(objData.lightType) {
                        case 'pointlight':
                            light = new THREE.PointLight(objData.color, objData.intensity, 50);
                            break;
                        case 'directionallight':
                            light = new THREE.DirectionalLight(objData.color, objData.intensity);
                            break;
                        case 'spotlight':
                            light = new THREE.SpotLight(objData.color, objData.intensity);
                            light.angle = objData.angle || Math.PI / 6;
                            light.penumbra = objData.penumbra || 0.2;
                            break;
                        case 'ambientlight':
                            light = new THREE.AmbientLight(objData.color, objData.intensity);
                            break;
                    }
                    
                    if (light) {
                        light.name = objData.name;
                        if (light.position) {
                            light.position.set(objData.position[0], objData.position[1], objData.position[2]);
                        }
                        
                        if (light.isPointLight || light.isDirectionalLight || light.isSpotLight) {
                            light.castShadow = true;
                            light.shadow.mapSize.width = 1024;
                            light.shadow.mapSize.height = 1024;
                        }
                        
                        this.scene.add(light);
                        this.objects.push(light);
                        this.lights.push(light);
                    }
                }
            });
            
            signals.sceneGraphChanged.dispatch();
        });
    }
}

// UI
class UI {
    constructor(editor) {
        this.editor = editor;
        this.container = document.createElement('div');
        document.body.appendChild(this.container);
        
        this.viewport = document.getElementById('viewport');
        this.viewport.appendChild(this.editor.renderer.domElement);
        
        this.menubar = document.getElementById('menubar');
        this.sidebar = document.querySelector('.right-panel');
        this.toolbar = document.getElementById('toolbar');
        
        this.notification = document.getElementById('notification');
        this.loadingIndicator = document.getElementById('loading-indicator');
        this.modal = document.getElementById('modal');
        
        this.setupMenubar();
        this.setupSidebar();
        this.setupToolbar();
        this.setupEventListeners();
        
        // Initial grid
        this.createGrid();
        
        // Add initial objects
        this.editor.setEnvironment('studio');
        
        // Setup animation loop
        this.animate();
    }
    
    setupMenubar() {
        const menuItems = [
            {
                title: 'File',
                options: [
                    { title: 'New Scene', action: () => this.newScene() },
                    { title: 'Import Model', action: () => this.importModel() },
                    { title: 'Export Scene', action: () => this.exportScene() },
                    { title: 'Save Scene', action: () => this.editor.saveState() },
                    { title: 'Load Scene', action: () => this.editor.loadState() }
                ]
            },
            {
                title: 'Edit',
                options: [
                    { title: 'Undo', action: () => this.editor.undo() },
                    { title: 'Redo', action: () => this.editor.redo() },
                    { title: 'Center Selected', action: () => this.centerSelected() },
                    { title: 'Delete Selected', action: () => this.deleteSelected() },
                    { title: 'Duplicate Selected', action: () => this.duplicateSelected() }
                ]
            },
            {
                title: 'Add',
                options: [
                    { title: 'Cube', action: () => this.editor.createPrimitive('cube') },
                    { title: 'Sphere', action: () => this.editor.createPrimitive('sphere') },
                    { title: 'Cylinder', action: () => this.editor.createPrimitive('cylinder') },
                    { title: 'Cone', action: () => this.editor.createPrimitive('cone') },
                    { title: 'Torus', action: () => this.editor.createPrimitive('torus') },
                    { title: 'Torus Knot', action: () => this.editor.createPrimitive('knot') },
                    { title: 'Point Light', action: () => this.editor.createLight('point') },
                    { title: 'Directional Light', action: () => this.editor.createLight('directional') },
                    { title: 'Spot Light', action: () => this.editor.createLight('spot') },
                    { title: 'Ambient Light', action: () => this.editor.createLight('ambient') }
                ]
            },
            {
                title: 'View',
                options: [
                    { title: 'Grid', action: () => this.toggleGrid() },
                    { title: 'Shadows', action: () => this.toggleShadows() },
                    { title: 'Bloom Effect', action: () => this.toggleBloom() },
                    { title: 'Help', action: () => this.showHelp() }
                ]
            }
        ];
        
        menuItems.forEach(item => {
            const menu = document.createElement('div');
            menu.className = 'menu';
            
            const title = document.createElement('div');
            title.className = 'title';
            title.textContent = item.title;
            menu.appendChild(title);
            
            const options = document.createElement('div');
            options.className = 'options';
            menu.appendChild(options);
            
            item.options.forEach(option => {
                const div = document.createElement('div');
                div.className = 'option';
                div.textContent = option.title;
                div.addEventListener('click', option.action);
                options.appendChild(div);
            });
            
            this.menubar.appendChild(menu);
        });
    }
    
    setupSidebar() {
        // Scene Outliner
        const outliner = document.getElementById('outliner');
        
        // Properties Panel
        const propertiesContainer = document.getElementById('properties-container');
        
        // Update outliner when objects change
        const updateOutliner = () => {
            outliner.innerHTML = '';
            
            this.editor.objects.forEach(object => {
                const option = document.createElement('div');
                option.className = 'outliner-item';
                option.textContent = object.name || 'Object';
                option.addEventListener('click', () => {
                    this.editor.select(object);
                });
                
                if (object === this.editor.selected) {
                    option.classList.add('selected');
                }
                
                outliner.appendChild(option);
            });
        };
        
        signals.objectAdded.add(updateOutliner);
        signals.objectRemoved.add(updateOutliner);
        signals.objectSelected.add(updateOutliner);
        
        // Update properties panel when selection changes
        signals.objectSelected.add(object => {
            propertiesContainer.innerHTML = '';
            
            if (!object) return;
            
            // Name field
            const nameRow = document.createElement('div');
            nameRow.className = 'property-row';
            
            const nameLabel = document.createElement('div');
            nameLabel.className = 'property-label';
            nameLabel.textContent = 'Name';
            nameRow.appendChild(nameLabel);
            
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = object.name || '';
            nameInput.className = 'property-value';
            nameInput.addEventListener('change', () => {
                object.name = nameInput.value;
                updateOutliner();
            });
            nameRow.appendChild(nameInput);
            
            propertiesContainer.appendChild(nameRow);
            
            // Visible field
            const visibleRow = document.createElement('div');
            visibleRow.className = 'property-row';
            
            const visibleLabel = document.createElement('div');
            visibleLabel.className = 'property-label';
            visibleLabel.textContent = 'Visible';
            visibleRow.appendChild(visibleLabel);
            
            const visibleCheckbox = document.createElement('input');
            visibleCheckbox.type = 'checkbox';
            visibleCheckbox.checked = object.visible;
            visibleCheckbox.addEventListener('change', () => {
                object.visible = visibleCheckbox.checked;
                signals.objectChanged.dispatch(object);
            });
            visibleRow.appendChild(visibleCheckbox);
            
            propertiesContainer.appendChild(visibleRow);
            
            // Cast Shadow field (for meshes and lights)
            if (object.isMesh || (object.isLight && !object.isAmbientLight)) {
                const castShadowRow = document.createElement('div');
                castShadowRow.className = 'property-row';
                
                const castShadowLabel = document.createElement('div');
                castShadowLabel.className = 'property-label';
                castShadowLabel.textContent = 'Cast Shadow';
                castShadowRow.appendChild(castShadowLabel);
                
                const castShadowCheckbox = document.createElement('input');
                castShadowCheckbox.type = 'checkbox';
                castShadowCheckbox.checked = object.castShadow;
                castShadowCheckbox.addEventListener('change', () => {
                    object.castShadow = castShadowCheckbox.checked;
                    if (object.isLight) {
                        signals.lightChanged.dispatch(object);
                    } else {
                        signals.objectChanged.dispatch(object);
                    }
                });
                castShadowRow.appendChild(castShadowCheckbox);
                
                propertiesContainer.appendChild(castShadowRow);
            }
            
            // Receive Shadow field (for meshes)
            if (object.isMesh) {
                const receiveShadowRow = document.createElement('div');
                receiveShadowRow.className = 'property-row';
                
                const receiveShadowLabel = document.createElement('div');
                receiveShadowLabel.className = 'property-label';
                receiveShadowLabel.textContent = 'Receive Shadow';
                receiveShadowRow.appendChild(receiveShadowLabel);
                
                const receiveShadowCheckbox = document.createElement('input');
                receiveShadowCheckbox.type = 'checkbox';
                receiveShadowCheckbox.checked = object.receiveShadow;
                receiveShadowCheckbox.addEventListener('change', () => {
                    object.receiveShadow = receiveShadowCheckbox.checked;
                    signals.objectChanged.dispatch(object);
                });
                receiveShadowRow.appendChild(receiveShadowCheckbox);
                
                propertiesContainer.appendChild(receiveShadowRow);
            }
            
            // Transform Section
            const transformHeader = document.createElement('div');
            transformHeader.className = 'panel-header';
            transformHeader.textContent = 'Transform';
            propertiesContainer.appendChild(transformHeader);
            
            // Position fields
            const positionRow = document.createElement('div');
            positionRow.className = 'property-row';
            
            const positionLabel = document.createElement('div');
            positionLabel.className = 'property-label';
            positionLabel.textContent = 'Position';
            positionRow.appendChild(positionLabel);
            
            const positionContainer = document.createElement('div');
            positionContainer.className = 'coord-input';
            
            ['x', 'y', 'z'].forEach((axis, index) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.step = '0.1';
                input.value = object.position[axis].toFixed(2);
                input.addEventListener('change', () => {
                    object.position[axis] = parseFloat(input.value);
                    signals.objectChanged.dispatch(object);
                });
                positionContainer.appendChild(input);
            });
            
            positionRow.appendChild(positionContainer);
            propertiesContainer.appendChild(positionRow);
            
            // Rotation fields
            if (object.rotation) {
                const rotationRow = document.createElement('div');
                rotationRow.className = 'property-row';
                
                const rotationLabel = document.createElement('div');
                rotationLabel.className = 'property-label';
                rotationLabel.textContent = 'Rotation';
                rotationRow.appendChild(rotationLabel);
                
                const rotationContainer = document.createElement('div');
                rotationContainer.className = 'coord-input';
                
                ['x', 'y', 'z'].forEach((axis, index) => {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.step = '1';
                    input.value = THREE.MathUtils.radToDeg(object.rotation[axis]).toFixed(1);
                    input.addEventListener('change', () => {
                        object.rotation[axis] = THREE.MathUtils.degToRad(parseFloat(input.value));
                        signals.objectChanged.dispatch(object);
                    });
                    rotationContainer.appendChild(input);
                });
                
                rotationRow.appendChild(rotationContainer);
                propertiesContainer.appendChild(rotationRow);
            }
            
            // Scale fields (for meshes)
            if (object.scale) {
                const scaleRow = document.createElement('div');
                scaleRow.className = 'property-row';
                
                const scaleLabel = document.createElement('div');
                scaleLabel.className = 'property-label';
                scaleLabel.textContent = 'Scale';
                scaleRow.appendChild(scaleLabel);
                
                const scaleContainer = document.createElement('div');
                scaleContainer.className = 'coord-input';
                
                ['x', 'y', 'z'].forEach((axis, index) => {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.step = '0.1';
                    input.value = object.scale[axis].toFixed(2);
                    input.addEventListener('change', () => {
                        object.scale[axis] = parseFloat(input.value);
                        signals.objectChanged.dispatch(object);
                    });
                    scaleContainer.appendChild(input);
                });
                
                scaleRow.appendChild(scaleContainer);
                propertiesContainer.appendChild(scaleRow);
            }
            
            // Material properties (for meshes)
            if (object.isMesh && object.material) {
                const materialHeader = document.createElement('div');
                materialHeader.className = 'panel-header';
                materialHeader.textContent = 'Material';
                propertiesContainer.appendChild(materialHeader);
                
                // Type
                const typeRow = document.createElement('div');
                typeRow.className = 'property-row';
                
                const typeLabel = document.createElement('div');
                typeLabel.className = 'property-label';
                typeLabel.textContent = 'Type';
                typeRow.appendChild(typeLabel);
                
                const typeSelect = document.createElement('select');
                typeSelect.className = 'property-value';
                ['MeshStandardMaterial'].forEach(type => {
                    const option = document.createElement('option');
                    option.value = type;
                    option.textContent = type;
                    if (object.material.type === type) {
                        option.selected = true;
                    }
                    typeSelect.appendChild(option);
                });
                typeRow.appendChild(typeSelect);
                
                propertiesContainer.appendChild(typeRow);
                
                // Color
                const colorRow = document.createElement('div');
                colorRow.className = 'property-row';
                
                const colorLabel = document.createElement('div');
                colorLabel.className = 'property-label';
                colorLabel.textContent = 'Color';
                colorRow.appendChild(colorLabel);
                
                const colorInput = document.createElement('input');
                colorInput.type = 'color';
                colorInput.value = '#' + object.material.color.getHexString();
                colorInput.addEventListener('input', () => {
                    object.material.color.set(colorInput.value);
                    signals.materialChanged.dispatch(object.material);
                });
                colorRow.appendChild(colorInput);
                
                propertiesContainer.appendChild(colorRow);
                
                // Metalness
                const metalnessRow = document.createElement('div');
                metalnessRow.className = 'property-row';
                
                const metalnessLabel = document.createElement('div');
                metalnessLabel.className = 'property-label';
                metalnessLabel.textContent = 'Metalness';
                metalnessRow.appendChild(metalnessLabel);
                
                const metalnessSlider = document.createElement('input');
                metalnessSlider.type = 'range';
                metalnessSlider.min = '0';
                metalnessSlider.max = '1';
                metalnessSlider.step = '0.01';
                metalnessSlider.value = object.material.metalness;
                metalnessSlider.className = 'property-value';
                metalnessSlider.addEventListener('input', () => {
                    object.material.metalness = parseFloat(metalnessSlider.value);
                    signals.materialChanged.dispatch(object.material);
                });
                
                metalnessRow.appendChild(metalnessSlider);
                propertiesContainer.appendChild(metalnessRow);
                
                // Roughness
                const roughnessRow = document.createElement('div');
                roughnessRow.className = 'property-row';
                
                const roughnessLabel = document.createElement('div');
                roughnessLabel.className = 'property-label';
                roughnessLabel.textContent = 'Roughness';
                roughnessRow.appendChild(roughnessLabel);
                
                const roughnessSlider = document.createElement('input');
                roughnessSlider.type = 'range';
                roughnessSlider.min = '0';
                roughnessSlider.max = '1';
                roughnessSlider.step = '0.01';
                roughnessSlider.value = object.material.roughness;
                roughnessSlider.className = 'property-value';
                roughnessSlider.addEventListener('input', () => {
                    object.material.roughness = parseFloat(roughnessSlider.value);
                    signals.materialChanged.dispatch(object.material);
                });
                
                roughnessRow.appendChild(roughnessSlider);
                propertiesContainer.appendChild(roughnessRow);
                
                // Wireframe
                const wireframeRow = document.createElement('div');
                wireframeRow.className = 'property-row';
                
                const wireframeLabel = document.createElement('div');
                wireframeLabel.className = 'property-label';
                wireframeLabel.textContent = 'Wireframe';
                wireframeRow.appendChild(wireframeLabel);
                
                const wireframeCheckbox = document.createElement('input');
                wireframeCheckbox.type = 'checkbox';
                wireframeCheckbox.checked = object.material.wireframe;
                wireframeCheckbox.addEventListener('change', () => {
                    object.material.wireframe = wireframeCheckbox.checked;
                    signals.materialChanged.dispatch(object.material);
                });
                wireframeRow.appendChild(wireframeCheckbox);
                
                propertiesContainer.appendChild(wireframeRow);
            }
            
            // Light properties
            if (object.isLight) {
                const lightHeader = document.createElement('div');
                lightHeader.className = 'panel-header';
                lightHeader.textContent = 'Light';
                propertiesContainer.appendChild(lightHeader);
                
                // Color
                const colorRow = document.createElement('div');
                colorRow.className = 'property-row';
                
                const colorLabel = document.createElement('div');
                colorLabel.className = 'property-label';
                colorLabel.textContent = 'Color';
                colorRow.appendChild(colorLabel);
                
                const colorInput = document.createElement('input');
                colorInput.type = 'color';
                colorInput.value = '#' + object.color.getHexString();
                colorInput.addEventListener('input', () => {
                    object.color.set(colorInput.value);
                    signals.lightChanged.dispatch(object);
                });
                colorRow.appendChild(colorInput);
                
                propertiesContainer.appendChild(colorRow);
                
                // Intensity
                const intensityRow = document.createElement('div');
                intensityRow.className = 'property-row';
                
                const intensityLabel = document.createElement('div');
                intensityLabel.className = 'property-label';
                intensityLabel.textContent = 'Intensity';
                intensityRow.appendChild(intensityLabel);
                
                const intensitySlider = document.createElement('input');
                intensitySlider.type = 'range';
                intensitySlider.min = '0';
                intensitySlider.max = '2';
                intensitySlider.step = '0.01';
                intensitySlider.value = object.intensity;
                intensitySlider.className = 'property-value';
                intensitySlider.addEventListener('input', () => {
                    object.intensity = parseFloat(intensitySlider.value);
                    signals.lightChanged.dispatch(object);
                });
                
                intensityRow.appendChild(intensitySlider);
                propertiesContainer.appendChild(intensityRow);
                
                // Specific light properties
                if (object.isSpotLight) {
                    // Angle
                    const angleRow = document.createElement('div');
                    angleRow.className = 'property-row';
                    
                    const angleLabel = document.createElement('div');
                    angleLabel.className = 'property-label';
                    angleLabel.textContent = 'Angle';
                    angleRow.appendChild(angleLabel);
                    
                    const angleSlider = document.createElement('input');
                    angleSlider.type = 'range';
                    angleSlider.min = '0';
                    angleSlider.max = '1.57'; // PI/2
                    angleSlider.step = '0.01';
                    angleSlider.value = object.angle;
                    angleSlider.className = 'property-value';
                    angleSlider.addEventListener('input', () => {
                        object.angle = parseFloat(angleSlider.value);
                        signals.lightChanged.dispatch(object);
                    });
                    
                    angleRow.appendChild(angleSlider);
                    propertiesContainer.appendChild(angleRow);
                    
                    // Penumbra
                    const penumbraRow = document.createElement('div');
                    penumbraRow.className = 'property-row';
                    
                    const penumbraLabel = document.createElement('div');
                    penumbraLabel.className = 'property-label';
                    penumbraLabel.textContent = 'Penumbra';
                    penumbraRow.appendChild(penumbraLabel);
                    
                    const penumbraSlider = document.createElement('input');
                    penumbraSlider.type = 'range';
                    penumbraSlider.min = '0';
                    penumbraSlider.max = '1';
                    penumbraSlider.step = '0.01';
                    penumbraSlider.value = object.penumbra;
                    penumbraSlider.className = 'property-value';
                    penumbraSlider.addEventListener('input', () => {
                        object.penumbra = parseFloat(penumbraSlider.value);
                        signals.lightChanged.dispatch(object);
                    });
                    
                    penumbraRow.appendChild(penumbraSlider);
                    propertiesContainer.appendChild(penumbraRow);
                }
            }
            
            // Post-processing (for bloom effect, shown for all objects)
            const postProcessingHeader = document.createElement('div');
            postProcessingHeader.className = 'panel-header';
            postProcessingHeader.textContent = 'Post-processing';
            propertiesContainer.appendChild(postProcessingHeader);
            
            // Bloom Enabled
            const bloomRow = document.createElement('div');
            bloomRow.className = 'property-row';
            
            const bloomLabel = document.createElement('div');
            bloomLabel.className = 'property-label';
            bloomLabel.textContent = 'Bloom';
            bloomRow.appendChild(bloomLabel);
            
            const bloomCheckbox = document.createElement('input');
            bloomCheckbox.type = 'checkbox';
            const bloomPass = this.editor.composer.passes.find(pass => pass instanceof UnrealBloomPass);
            bloomCheckbox.checked = bloomPass.enabled;
            bloomCheckbox.addEventListener('change', () => {
                bloomPass.enabled = bloomCheckbox.checked;
                this.showNotification(bloomPass.enabled ? 'Bloom effect enabled' : 'Bloom effect disabled');
            });
            bloomRow.appendChild(bloomCheckbox);
            
            propertiesContainer.appendChild(bloomRow);
            
            // Bloom Intensity
            const bloomIntensityRow = document.createElement('div');
            bloomIntensityRow.className = 'property-row';
            
            const bloomIntensityLabel = document.createElement('div');
            bloomIntensityLabel.className = 'property-label';
            bloomIntensityLabel.textContent = 'Intensity';
            bloomIntensityRow.appendChild(bloomIntensityLabel);
            
            const bloomIntensitySlider = document.createElement('input');
            bloomIntensitySlider.type = 'range';
            bloomIntensitySlider.min = '0';
            bloomIntensitySlider.max = '3';
            bloomIntensitySlider.step = '0.01';
            bloomIntensitySlider.value = bloomPass.strength;
            bloomIntensitySlider.className = 'property-value';
            bloomIntensitySlider.addEventListener('input', () => {
                bloomPass.strength = parseFloat(bloomIntensitySlider.value);
            });
            
            bloomIntensityRow.appendChild(bloomIntensitySlider);
            propertiesContainer.appendChild(bloomIntensityRow);
            
            // Bloom Threshold
            const bloomThresholdRow = document.createElement('div');
            bloomThresholdRow.className = 'property-row';
            
            const bloomThresholdLabel = document.createElement('div');
            bloomThresholdLabel.className = 'property-label';
            bloomThresholdLabel.textContent = 'Threshold';
            bloomThresholdRow.appendChild(bloomThresholdLabel);
            
            const bloomThresholdSlider = document.createElement('input');
            bloomThresholdSlider.type = 'range';
            bloomThresholdSlider.min = '0';
            bloomThresholdSlider.max = '1';
            bloomThresholdSlider.step = '0.01';
            bloomThresholdSlider.value = bloomPass.threshold;
            bloomThresholdSlider.className = 'property-value';
            bloomThresholdSlider.addEventListener('input', () => {
                bloomPass.threshold = parseFloat(bloomThresholdSlider.value);
            });
            
            bloomThresholdRow.appendChild(bloomThresholdSlider);
            propertiesContainer.appendChild(bloomThresholdRow);
        });
    }
    
    setupToolbar() {
        const tools = [
            { title: 'Select', icon: '⊙', action: () => this.setMode('select') },
            { title: 'Move', icon: '↔', action: () => this.setMode('move') },
            { title: 'Rotate', icon: '⟲', action: () => this.setMode('rotate') },
            { title: 'Scale', icon: '⤧', action: () => this.setMode('scale') }
        ];
        
        const toolGroup = document.createElement('div');
        toolGroup.className = 'tool-group';
        
        tools.forEach(tool => {
            const button = document.createElement('button');
            button.className = 'tool-button';
            button.title = tool.title;
            button.textContent = tool.icon;
            button.addEventListener('click', tool.action);
            
            // Update active state
            if (this.editor.mode === tool.title.toLowerCase()) {
                button.classList.add('active');
            }
            
            toolGroup.appendChild(button);
        });
        
        this.toolbar.appendChild(toolGroup);
        
        // Update toolbar on mode change
        signals.modeChanged.add(mode => {
            const buttons = this.toolbar.querySelectorAll('.tool-button');
            buttons.forEach(button => {
                button.classList.remove('active');
                if (button.title.toLowerCase() === mode) {
                    button.classList.add('active');
                }
            });
        });
    }
    
    setupEventListeners() {
        // Window resize
        const updateRendererSize = () => {
            const leftPanel = document.querySelector('.left-panel');
            const rightPanel = document.querySelector('.right-panel');
            const leftWidth = leftPanel.classList.contains('collapsed') ? 48 : 240;
            const rightWidth = rightPanel.classList.contains('collapsed') ? 0 : 300;
            const viewportWidth = window.innerWidth - leftWidth - rightWidth;
            const viewportHeight = window.innerHeight - 72; // Header (48px) + Toolbar (40px) + Statusbar (24px)
            
            this.editor.camera.aspect = viewportWidth / viewportHeight;
            this.editor.camera.updateProjectionMatrix();
            this.editor.renderer.setSize(viewportWidth, viewportHeight);
            this.editor.composer.setSize(viewportWidth, viewportHeight);
        };
        
        window.addEventListener('resize', () => {
            updateRendererSize();
            signals.windowResize.dispatch();
        });
        
        // Panel toggles
        const leftPanel = document.querySelector('.left-panel');
        const leftPanelToggle = document.getElementById('left-panel-toggle');
        leftPanelToggle.addEventListener('click', () => {
            leftPanel.classList.toggle('collapsed');
            updateRendererSize();
        });
        
        const rightPanel = document.querySelector('.right-panel');
        const rightPanelToggle = document.getElementById('right-panel-toggle');
        rightPanelToggle.addEventListener('click', () => {
            rightPanel.classList.toggle('collapsed');
            updateRendererSize();
        });
        
        // Environment selector
        const environmentSelector = document.getElementById('environment-selector');
        environmentSelector.addEventListener('change', () => {
            this.editor.setEnvironment(environmentSelector.value);
            this.showNotification(`Environment set to ${environmentSelector.value}`);
        });
        
        // Object selection
        this.editor.renderer.domElement.addEventListener('click', (event) => {
            if (this.editor.mode !== 'select') return;
            
            const rect = this.editor.renderer.domElement.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera({ x, y }, this.editor.camera);
            
            const intersects = raycaster.intersectObjects(this.editor.objects, true);
            
            if (intersects.length > 0) {
                let object = intersects[0].object;
                
                // If it's part of a group, select the group instead
                while (object.parent && object.parent !== this.editor.scene) {
                    object = object.parent;
                }
                
                this.editor.select(object);
            } else {
                this.editor.select(null);
            }
        });
        
        // Help modal
        const modalClose = document.getElementById('modal-close');
        if (modalClose) {
            modalClose.addEventListener('click', () => {
                this.modal.classList.remove('show');
            });
        }
        
        // Object change signals
        signals.objectChanged.add(() => {
            this.editor.saveState();
        });
        
        signals.materialChanged.add(() => {
            this.editor.saveState();
        });
        
        signals.lightChanged.add(() => {
            this.editor.saveState();
        });
        
        // Initial renderer size
        updateRendererSize();
    }
    
    createGrid() {
        // Remove existing grid if any
        this.editor.scene.traverse(obj => {
            if (obj.isGridHelper) {
                this.editor.scene.remove(obj);
            }
        });
        
        // Create new grid
        const grid = new THREE.GridHelper(20, 20, 0x444444, 0x888888);
        grid.isGridHelper = true;
        this.editor.scene.add(grid);
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());
        
        this.editor.controls.update();
        this.editor.composer.render();
    }
    
    // UI Actions
    newScene() {
        // Clear existing objects
        while (this.editor.objects.length > 0) {
            const obj = this.editor.objects[0];
            this.editor.removeObject(obj);
        }
        
        // Reset history
        this.editor.actionHistory = [];
        this.editor.historyIndex = -1;
        
        // Reset environment
        this.editor.setEnvironment('studio');
        
        // Create grid
        this.createGrid();
        
        // Show notification
        this.showNotification('New scene created');
    }
    
    importModel() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.gltf,.glb';
        input.style.display = 'none';
        document.body.appendChild(input);
        
        input.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (!file) return;
            
            this.showLoading(true);
            
            this.editor.importModel(file)
                .then(model => {
                    this.showNotification(`Imported model: ${file.name}`);
                    this.showLoading(false);
                })
                .catch(error => {
                    console.error('Error importing model:', error);
                    this.showNotification(`Error importing model: ${error.message}`, true);
                    this.showLoading(false);
                });
            
            document.body.removeChild(input);
        });
        
        input.click();
    }
    
    exportScene() {
        this.showLoading(true);
        
        this.editor.exportScene()
            .then(blob => {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = 'scene.gltf';
                link.click();
                
                this.showNotification('Scene exported successfully');
                this.showLoading(false);
            })
            .catch(error => {
                console.error('Error exporting scene:', error);
                this.showNotification('Error exporting scene', true);
                this.showLoading(false);
            });
    }
    
    centerSelected() {
        if (!this.editor.selected) return;
        
        this.editor.selected.position.set(0, 0, 0);
        signals.objectChanged.dispatch(this.editor.selected);
        this.showNotification('Object centered');
    }
    
    deleteSelected() {
        if (!this.editor.selected) return;
        
        this.editor.removeObject(this.editor.selected);
        this.editor.select(null);
        this.showNotification('Object deleted');
    }
    
    duplicateSelected() {
        if (!this.editor.selected) return;
        
        let newObject;
        
        if (this.editor.selected.isMesh) {
            // Clone mesh
            newObject = this.editor.selected.clone();
            
            // Clone material to avoid shared materials
            newObject.material = this.editor.selected.material.clone();
            
            // Offset position slightly
            newObject.position.x += 1;
            
            // Update name
            newObject.name = this.editor.selected.name + ' (Copy)';
            
            this.editor.addObject(newObject);
            this.editor.select(newObject);
            
        } else if (this.editor.selected.isLight) {
            // Create new light of same type
            let lightType;
            
            if (this.editor.selected.isPointLight) lightType = 'point';
            else if (this.editor.selected.isDirectionalLight) lightType = 'directional';
            else if (this.editor.selected.isSpotLight) lightType = 'spot';
            else if (this.editor.selected.isAmbientLight) lightType = 'ambient';
            
            if (lightType) {
                newObject = this.editor.createLight(lightType);
                
                // Copy properties
                newObject.color.copy(this.editor.selected.color);
                newObject.intensity = this.editor.selected.intensity;
                
                if (newObject.position && this.editor.selected.position) {
                    newObject.position.copy(this.editor.selected.position);
                    newObject.position.x += 1; // Offset slightly
                }
                
                if (this.editor.selected.isSpotLight && newObject.isSpotLight) {
                    newObject.angle = this.editor.selected.angle;
                    newObject.penumbra = this.editor.selected.penumbra;
                }
                
                newObject.castShadow = this.editor.selected.castShadow;
                newObject.name = this.editor.selected.name + ' (Copy)';
            }
        }
        
        if (newObject) {
            this.showNotification('Object duplicated');
        }
    }
    
    toggleGrid() {
        this.editor.scene.traverse(obj => {
            if (obj.isGridHelper) {
                obj.visible = !obj.visible;
                this.showNotification(obj.visible ? 'Grid enabled' : 'Grid disabled');
            }
        });
    }
    
    toggleShadows() {
        let shadowsEnabled = false;
        this.editor.scene.traverse(obj => {
            if (obj.isLight && (obj.isPointLight || obj.isDirectionalLight || obj.isSpotLight)) {
                shadowsEnabled = obj.castShadow;
            }
        });
        
        shadowsEnabled = !shadowsEnabled;
        
        this.editor.scene.traverse(obj => {
            if (obj.isLight && (obj.isPointLight || obj.isDirectionalLight || obj.isSpotLight)) {
                obj.castShadow = shadowsEnabled;
            }
            if (obj.isMesh) {
                obj.castShadow = shadowsEnabled;
                obj.receiveShadow = shadowsEnabled;
            }
        });
        
        this.editor.renderer.shadowMap.enabled = shadowsEnabled;
        this.showNotification(shadowsEnabled ? 'Shadows enabled' : 'Shadows disabled');
    }
    
    toggleBloom() {
        const bloomPass = this.editor.composer.passes.find(pass => pass instanceof UnrealBloomPass);
        bloomPass.enabled = !bloomPass.enabled;
        this.showNotification(bloomPass.enabled ? 'Bloom effect enabled' : 'Bloom effect disabled');
    }
    
    showHelp() {
        this.modal.classList.add('show');
    }
    
    showNotification(message, error = false) {
        this.notification.textContent = message;
        this.notification.classList.remove('error');
        if (error) {
            this.notification.classList.add('error');
        }
        this.notification.classList.add('show');
        
        setTimeout(() => {
            this.notification.classList.remove('show');
        }, 3000);
    }
    
    showLoading(show) {
        this.loadingIndicator.style.display = show ? 'flex' : 'none';
    }
    
    setMode(mode) {
        this.editor.mode = mode;
        signals.modeChanged.dispatch(mode);
        this.showNotification(`Mode set to ${mode}`);
    }
}

// Initialize the editor and UI
const editor = new Editor();
const ui = new UI(editor);

// Load saved state
editor.loadState();