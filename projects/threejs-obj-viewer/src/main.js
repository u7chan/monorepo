import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";

class OBJViewer {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.currentModel = null;
    this.gridHelpers = [];
    this.axesHelper = null;

    this.init();
    this.setupEventListeners();
  }

  init() {
    // シーンの作成
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // 薄い青系統 (SkyBlue)

    // カメラの作成
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    this.camera.position.set(0, 0, 5);

    // レンダラーの作成
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // 深度テストの精度を上げてちらつきを防ぐ
    this.renderer.logarithmicDepthBuffer = true;

    // レンダラーをDOMに追加
    const container = document.getElementById("canvas-container");
    container.appendChild(this.renderer.domElement);

    // コントロールの設定
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 100;

    // ライトの設定
    this.setupLighting();

    // グリッドと軸の設定
    this.setupGridAndAxes();

    // アニメーションループの開始
    this.animate();

    // リサイズイベント
    window.addEventListener("resize", () => this.onWindowResize());
  }

  setupLighting() {
    // 環境光
    const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    this.scene.add(ambientLight);

    // 方向光源1
    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight1.position.set(5, 5, 5);
    directionalLight1.castShadow = true;
    directionalLight1.shadow.mapSize.width = 2048;
    directionalLight1.shadow.mapSize.height = 2048;
    this.scene.add(directionalLight1);

    // 方向光源2（反対側から）
    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-5, -5, -5);
    this.scene.add(directionalLight2);

    // ポイントライト
    const pointLight = new THREE.PointLight(0xffffff, 0.5, 50);
    pointLight.position.set(0, 10, 0);
    this.scene.add(pointLight);
  }

  setupGridAndAxes() {
    // グリッドヘルパーを追加（XZ平面のみ）
    const gridSize = 20;
    const divisions = 20;

    // XZ平面のグリッド（水平）のみ
    const gridHelperXZ = new THREE.GridHelper(
      gridSize,
      divisions,
      0x444444,
      0x222222
    );
    gridHelperXZ.renderOrder = 0; // 軸より先に描画
    this.scene.add(gridHelperXZ);
    this.gridHelpers.push(gridHelperXZ);

    // XYZ軸ヘルパーを追加（グリッドより少し上に配置してちらつきを防ぐ）
    this.axesHelper = new THREE.AxesHelper(5);
    this.axesHelper.position.y = 0.01; // わずかに上に配置
    this.axesHelper.renderOrder = 1; // グリッドより後に描画
    this.scene.add(this.axesHelper);
  }

  setupEventListeners() {
    const objFileInput = document.getElementById("obj-file");
    const mtlFileInput = document.getElementById("mtl-file");
    const showGridCheckbox = document.getElementById("show-grid");
    const showAxesCheckbox = document.getElementById("show-axes");
    const backgroundColorInput = document.getElementById("background-color");

    objFileInput.addEventListener("change", (event) => {
      const objFile = event.target.files[0];
      const mtlFile = mtlFileInput.files[0];

      if (objFile) {
        this.loadModel(objFile, mtlFile);
      }
    });

    mtlFileInput.addEventListener("change", (event) => {
      const mtlFile = event.target.files[0];
      const objFile = objFileInput.files[0];

      if (objFile) {
        this.loadModel(objFile, mtlFile);
      }
    });

    // グリッド表示切り替え
    showGridCheckbox.addEventListener("change", (event) => {
      this.toggleGrid(event.target.checked);
    });

    // 軸表示切り替え
    showAxesCheckbox.addEventListener("change", (event) => {
      this.toggleAxes(event.target.checked);
    });

    // 背景色変更
    backgroundColorInput.addEventListener("change", (event) => {
      this.changeBackgroundColor(event.target.value);
    });
  }

  async loadModel(objFile, mtlFile = null) {
    this.showLoading(true);
    this.hideError();

    try {
      // 既存のモデルを削除
      if (this.currentModel) {
        this.scene.remove(this.currentModel);
        this.currentModel = null;
      }

      let materials = null;

      // MTLファイルがある場合は先に読み込む
      if (mtlFile) {
        materials = await this.loadMTL(mtlFile);
      }

      // OBJファイルを読み込む
      const object = await this.loadOBJ(objFile, materials);

      // モデルをシーンに追加
      this.scene.add(object);
      this.currentModel = object;

      // モデルの中心とサイズを計算してカメラを調整
      this.fitCameraToModel(object);

      this.showLoading(false);
    } catch (error) {
      console.error("モデルの読み込みエラー:", error);
      this.showError("モデルの読み込みに失敗しました: " + error.message);
      this.showLoading(false);
    }
  }

  loadMTL(mtlFile) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          console.log("MTLファイル読み込み開始:", mtlFile.name);
          console.log("MTLファイルの内容:", event.target.result);

          const mtlLoader = new MTLLoader();
          const materials = mtlLoader.parse(event.target.result, "");
          materials.preload();

          console.log("MTLマテリアル解析完了:", materials);
          console.log(
            "利用可能なマテリアル:",
            Object.keys(materials.materials)
          );

          resolve(materials);
        } catch (error) {
          console.error("MTL解析エラー:", error);
          reject(new Error("MTLファイルの解析に失敗しました"));
        }
      };
      reader.onerror = () =>
        reject(new Error("MTLファイルの読み込みに失敗しました"));
      reader.readAsText(mtlFile);
    });
  }

  loadOBJ(objFile, materials = null) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          console.log("OBJファイル読み込み開始:", objFile.name);
          console.log("マテリアルが設定されているか:", !!materials);

          const objLoader = new OBJLoader();

          if (materials) {
            console.log("マテリアルを設定中...");
            objLoader.setMaterials(materials);
          }

          const object = objLoader.parse(event.target.result);

          console.log("OBJ解析完了:", object);

          // デフォルトマテリアルの設定（MTLがない場合）
          if (!materials) {
            console.log("デフォルトマテリアルを適用中...");
            object.traverse((child) => {
              if (child.isMesh) {
                child.material = new THREE.MeshPhongMaterial({
                  color: 0x888888,
                  shininess: 30,
                });
                child.castShadow = true;
                child.receiveShadow = true;
              }
            });
          } else {
            console.log("MTLマテリアル適用、シャドウ設定中...");
            // シャドウの設定
            object.traverse((child) => {
              if (child.isMesh) {
                console.log("メッシュ発見:", child);
                console.log("マテリアル:", child.material);
                child.castShadow = true;
                child.receiveShadow = true;
              }
            });
          }

          resolve(object);
        } catch (error) {
          console.error("OBJ解析エラー:", error);
          reject(new Error("OBJファイルの解析に失敗しました"));
        }
      };
      reader.onerror = () =>
        reject(new Error("OBJファイルの読み込みに失敗しました"));
      reader.readAsText(objFile);
    });
  }

  fitCameraToModel(object) {
    // オブジェクトのバウンディングボックスを計算
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    // オブジェクトを中心に配置
    object.position.sub(center);

    // カメラの距離を調整
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    cameraZ *= 1.5; // 少し余裕を持たせる

    this.camera.position.set(0, 0, cameraZ);
    this.camera.lookAt(0, 0, 0);

    // コントロールの範囲を調整
    this.controls.maxDistance = cameraZ * 3;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  toggleGrid(show) {
    this.gridHelpers.forEach((grid) => {
      grid.visible = show;
    });
  }

  toggleAxes(show) {
    if (this.axesHelper) {
      this.axesHelper.visible = show;
    }
  }

  changeBackgroundColor(colorHex) {
    // HEXカラーをThree.jsのColorオブジェクトに変換
    this.scene.background = new THREE.Color(colorHex);

    // 背景色に応じてグリッドの色を調整（オプション）
    this.adjustGridColors(colorHex);
  }

  adjustGridColors(backgroundColorHex) {
    // 背景色の明度を計算
    const color = new THREE.Color(backgroundColorHex);
    const brightness = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;

    // 明度に応じてグリッドの色を調整
    let gridColor, gridCenterColor;
    if (brightness > 0.5) {
      // 明るい背景の場合は暗いグリッド
      gridColor = 0x333333;
      gridCenterColor = 0x555555;
    } else {
      // 暗い背景の場合は明るいグリッド
      gridColor = 0x888888;
      gridCenterColor = 0xaaaaaa;
    }

    // 既存のグリッドを更新
    this.gridHelpers.forEach((grid) => {
      if (grid.material && grid.material.length >= 2) {
        grid.material[0].color.setHex(gridCenterColor); // センターライン
        grid.material[1].color.setHex(gridColor); // グリッドライン
      }
    });
  }

  showLoading(show) {
    const loading = document.getElementById("loading");
    loading.style.display = show ? "block" : "none";
  }

  showError(message) {
    const error = document.getElementById("error");
    const errorMessage = document.getElementById("error-message");
    errorMessage.textContent = message;
    error.style.display = "block";
  }

  hideError() {
    const error = document.getElementById("error");
    error.style.display = "none";
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

// グローバル関数（HTMLから呼び出すため）
window.hideError = function () {
  const error = document.getElementById("error");
  error.style.display = "none";
};

// アプリケーションの初期化
document.addEventListener("DOMContentLoaded", () => {
  new OBJViewer();
});
