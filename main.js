import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import * as CANNON from 'cannon-es';

// ---------- 定数（テーブルのレイアウト） ----------
// 床の幅をさらに約1.3倍にワイド化（3.7 → 4.8）
const FIELD_HALF_X = 4.8;       // プレイフィールドの内側半幅
const WALL_Z_BACK = -3.2;
const EDGE_Z_FRONT = 3.2;       // これを超えたら「落ちて獲得」
// プッシャーは奥の壁際に固定された端から手前に伸縮するテレスコピック（伸び縮み）構造。
// 奥端は常にPUSHER_BACK_Zに固定し、そこからの長さ（半分＝halfLen）だけが
// PUSHER_HALF_LEN_MIN〜MAXの間で往復する。これにより：
// ・奥の壁とプッシャーの間に隙間が生まれない＝トラップゾーンが原理的にできない
// ・縮む時：プッシャーの上に乗っていたコインが、なくなった床の分だけ落下し、
// 　その時点のプッシャーのヘリ（＝下の床の上）に集まる
// ・伸びる時：ヘリに集まっていたコインをプッシャーの先端（垂直な面）が前へ押し出す
const PUSHER_BACK_Z = -3.0;
const PUSHER_HALF_LEN_MIN = 0.5;
const PUSHER_HALF_LEN_MAX = 2.5;
const PUSHER_HALF_LEN_CENTER = (PUSHER_HALF_LEN_MIN + PUSHER_HALF_LEN_MAX) / 2;
const PUSHER_HALF_LEN_AMP = (PUSHER_HALF_LEN_MAX - PUSHER_HALF_LEN_MIN) / 2;
const PUSHER_SPEED = 0.55;      // rad/s
// 落下開始位置。以前は3.0〜4.5と高めで、着地の勢いが強く軽そうに見えていたため引き下げ
// （山の最大想定高さ約0.6に対し、最低でも1.7の余裕を確保）
const SPAWN_Y = 2.3;
// コイン投入位置は「プッシャーの上の一番奥」＝プッシャーが常に固定されている奥端の
// すぐ手前。プッシャーの長さが最小の時でもこの位置は必ずプッシャーの上になる。
const SPAWN_Z = PUSHER_BACK_Z + 0.35;
const COIN_RADIUS = 0.35;
const COIN_HEIGHT = 0.09;
// 実測（150〜300枚でFPSがほぼ横ばい＝150枚付近が実質的な体感の境目）を踏まえて300から一度200へ引き下げていたが、
// 【2026-08-23】上限到達時に「一番古いコイン」を得点判定を経ずに間引く仕組み（下記spawnCoin参照）により、
// 得点ライン手前まで来ていたコインがGETされないまま消える不具合の一因になっていたため、
// 300枚まで戻す（過去の実測で150〜300は性能上ほぼ横ばいと確認済みの範囲内）
const MAX_COINS = 300;
// プッシャーに触れていないコインをこの速度未満で強制スリープさせる閾値
// （cannon-es既定のsleepSpeedLimitより緩め。密集した山の中で伝播する微振動を
// 早めに打ち切るため、多少余裕を持たせている）
const FORCE_SLEEP_SPEED = 0.35;
// 着地直後、この秒数の間は速度によらない即時強制スリープの対象から外す
// （自由落下からの着地バウンド演出を妨げないための猶予期間）
const LANDING_GRACE = 1.2;
// 【震え対策・再設計】「動いているもの」から離れてから、この秒数はそのまま様子を見る
// （即座に凍結すると、離れた瞬間の姿勢のまま不自然に静止してしまうため）
const IDLE_SLEEP_DELAY = 3.0;
// その後、この秒数をかけて減衰を徐々に強め、自然に減速しきってから初めてsleep()する
const IDLE_SLEEP_RAMP = 1.0;
const SETTLE_LINEAR_DAMPING = 0.95;
const SETTLE_ANGULAR_DAMPING = 0.9;
// 倒れ防止ロック（angularFactorをX/Z=0に絞る処理）を発動させる「水平度」のしきい値。
// ローカル上方向ベクトルをワールド変換したYが、1.0=完全水平のうちこの値を超えたら
// 「ほぼ水平」とみなす（0.97 ≈ 約14度以内）。まだ接触した瞬間で傾いている最中の
// コインまでこの値未満でロックしてしまうと、その傾きのまま凍結される不具合になる
// （テツさま実機報告）ため、水平に落ち着いてから初めてロックする方式にした。
const FLAT_LOCK_UP_THRESHOLD = 0.97;

// ---------- three.js セットアップ ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a12);
scene.fog = new THREE.Fog(0x0a0a12, 12, 26);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 100);
// 床の幅をさらに約1.3倍にワイド化したのに合わせてカメラもさらに引く
camera.position.set(0, 8.6, 12.8);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.3, 0.6);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 4;
controls.maxDistance = 18;
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.update();

// ライト
scene.add(new THREE.HemisphereLight(0xbfd6ff, 0x1a1410, 0.65));
const sun = new THREE.DirectionalLight(0xfff4d6, 1.35);
sun.position.set(4, 9, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -6;
sun.shadow.camera.right = 6;
sun.shadow.camera.top = 6;
sun.shadow.camera.bottom = -6;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 20;
scene.add(sun);

const spot = new THREE.PointLight(0x66aaff, 0.5, 12);
spot.position.set(-3, 3, -2);
scene.add(spot);

// コインの反対側から暖色のハイライトを当て、金属の輝く面を増やす（テツさま要望「光源を
// 増やせるか」への対応）。強度は既存ライトと白飛びしないよう控えめに。
const accentLight = new THREE.PointLight(0xffcc88, 0.45, 10);
accentLight.position.set(3, 2.5, 2.5);
scene.add(accentLight);

// ---------- 環境マップ（金属マテリアルの照り返し用） ----------
// これまでcoinMatGold/Silverのmetalnessを0.88/0.92止まりにしていたのは、環境マップが
// ない状態でmetalness:1.0にすると光の当たらない面が真っ黒に沈んでしまうため（既知の制約）。
// 外部画像を使わず、暖色グラデーションの小さな球体シーンをPMREM生成して`scene.environment`
// に設定することでこの制約自体を解消し、宝飾品のような全方位の照り返しを出す。
// 静的に一度だけ生成するため、毎フレームのコストはゼロ（他の金属パーツ＝金トリム・
// レール・ストッパー等にも同じ環境マップが自動的に効く）。
function buildEnvironmentTexture() {
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const envCanvas = document.createElement('canvas');
  envCanvas.width = 256;
  envCanvas.height = 128;
  const ectx = envCanvas.getContext('2d');
  const grad = ectx.createLinearGradient(0, 0, 0, envCanvas.height);
  grad.addColorStop(0, '#fff3d6');
  grad.addColorStop(0.35, '#caa153');
  grad.addColorStop(0.6, '#3a2410');
  grad.addColorStop(1, '#0b0805');
  ectx.fillStyle = grad;
  ectx.fillRect(0, 0, envCanvas.width, envCanvas.height);
  // 左右に暖色アクセントの帯（金の照り返し用ハイライト）
  ectx.fillStyle = 'rgba(255, 205, 122, 0.55)';
  ectx.fillRect(0, envCanvas.height * 0.22, envCanvas.width * 0.12, envCanvas.height * 0.3);
  ectx.fillRect(envCanvas.width * 0.88, envCanvas.height * 0.22, envCanvas.width * 0.12, envCanvas.height * 0.3);

  // 【2026-08-13：㊻ テツさま指摘「コインが木でできたもののように見える」】なだらかな
  // グラデーションだけでは反射に強弱がつかず、金属というより艶消しの質感に見えていた。
  // 宝石用環境マップ（buildGemEnvTexture）で効果が確認済みの「小さな高輝度スポットを
  // 散りばめる」手法を金属用にも適用し、面の向きによって明滅する鋭いハイライトを追加
  const metalSpots = [
    [0.08, 0.15, 1.0], [0.28, 0.30, 0.75], [0.5, 0.1, 0.9], [0.72, 0.25, 0.8],
    [0.92, 0.12, 1.0], [0.15, 0.55, 0.6], [0.4, 0.6, 0.7], [0.63, 0.5, 0.65],
    [0.85, 0.58, 0.75], [0.35, 0.85, 0.5], [0.65, 0.82, 0.55],
  ];
  for (const [sx, sy, b] of metalSpots) {
    const g = ectx.createRadialGradient(sx * envCanvas.width, sy * envCanvas.height, 0, sx * envCanvas.width, sy * envCanvas.height, envCanvas.width * 0.05);
    g.addColorStop(0, `rgba(255,250,235,${b})`);
    g.addColorStop(1, 'rgba(255,250,235,0)');
    ectx.fillStyle = g;
    ectx.fillRect(0, 0, envCanvas.width, envCanvas.height);
  }

  const envTex = new THREE.CanvasTexture(envCanvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.colorSpace = THREE.SRGBColorSpace;

  const envScene = new THREE.Scene();
  const envSphereGeo = new THREE.SphereGeometry(20, 32, 32);
  const envSphereMat = new THREE.MeshBasicMaterial({ map: envTex, side: THREE.BackSide });
  const envSphereMesh = new THREE.Mesh(envSphereGeo, envSphereMat);
  envScene.add(envSphereMesh);

  const rt = pmremGenerator.fromScene(envScene, 0.04);
  envSphereGeo.dispose();
  envSphereMat.dispose();
  envTex.dispose();
  pmremGenerator.dispose();
  return rt.texture;
}
// 【重要・パフォーマンス判断】当初は`scene.environment`にそのまま設定し、シーン全体の
// 全マテリアルに一括で環境マップを効かせる予定だったが、ヘッドレス無人テストで計測した
// ところ、画面占有率の大きい床・壁・プッシャーにまで環境マップのサンプリングコストが
// 及んでしまい、FPSが約半減する（例：オート投入30秒時点で26fps→15fps）ことが判明した。
// 環境マップが視覚的に効いてほしいのはコイン・金トリム・ストッパー・レール・ボールなどの
// 金属質パーツのみなので、`scene.environment`ではなく各マテリアルへ個別に`.envMap`を
// 設定する方式に変更し、コストを金属パーツだけに絞った（床・壁への適用をやめたことで
// FPSはほぼ元の水準まで回復することを確認済み）。実機の本物のGPUではこの種のコストは
// ヘッドレス（SwiftShader）よりずっと軽いと考えられるが、絞れるところは絞っておく。
const metalEnvTexture = buildEnvironmentTexture();

// ---------- 宝石専用の環境マップ（㊲：参考画像のような細かいきらめきを狙う） ----------
// 金属パーツ用のmetalEnvTextureは滑らかな4段グラデーションのため、ファセット面ごとの
// 反射差が出にくく「キラキラ」が弱かった。宝石専用に、暗い背景へ小さな高輝度スポットを
// 多数散りばめた環境マップを別途用意し、面ごとに異なる強さで反射させることで
// 参考画像（birthstone-list-all-items_square.png）のような複雑な煌めきに近づける。
function buildGemEnvTexture() {
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const W = 256, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#06060a';
  ctx.fillRect(0, 0, W, H);

  const spots = [
    [0.10, 0.20, 0.9], [0.32, 0.10, 1.0], [0.52, 0.28, 0.7], [0.74, 0.14, 0.95],
    [0.90, 0.38, 0.65], [0.20, 0.55, 0.55], [0.60, 0.58, 0.8], [0.42, 0.74, 0.5],
    [0.06, 0.78, 0.4], [0.83, 0.70, 0.6], [0.97, 0.20, 0.5], [0.66, 0.05, 0.6],
  ];
  for (const [sx, sy, b] of spots) {
    const g = ctx.createRadialGradient(sx * W, sy * H, 0, sx * W, sy * H, W * 0.045);
    g.addColorStop(0, `rgba(255,255,255,${b})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  const top = ctx.createLinearGradient(0, 0, 0, H * 0.55);
  top.addColorStop(0, 'rgba(210,222,255,0.4)');
  top.addColorStop(1, 'rgba(210,222,255,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, H * 0.55);

  const envTex = new THREE.CanvasTexture(canvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.colorSpace = THREE.SRGBColorSpace;

  const envScene = new THREE.Scene();
  const envSphereGeo = new THREE.SphereGeometry(20, 32, 32);
  const envSphereMat = new THREE.MeshBasicMaterial({ map: envTex, side: THREE.BackSide });
  const envSphereMesh = new THREE.Mesh(envSphereGeo, envSphereMat);
  envScene.add(envSphereMesh);

  const rt = pmremGenerator.fromScene(envScene, 0.015);
  envSphereGeo.dispose();
  envSphereMat.dispose();
  envTex.dispose();
  pmremGenerator.dispose();
  return rt.texture;
}
const gemEnvTexture = buildGemEnvTexture();

// ---------- cannon-es セットアップ ----------
// 実機のコインプッシャーはテーブルが手前に少し傾いている。
// ジオメトリを傾ける代わりに重力にZ成分を加えて同じ効果を再現する。
// 【2026-08-23】実機テストで「コイン同士が不自然に重なる・弾む」との指摘。同種の課題を
// 扱う外部事例（Bulletでの大量コインシミュレーション）を調査したところ、重力を実世界の値に
// 近づけることで衝突時の不自然なバウンドが解消したという知見があったため、Y成分を弱めた
// （実世界の約2倍→約1.1倍相当）。手前へ傾く「見た目のZ成分」は同じ比率を保つよう連動して
// 縮小してある（Yだけ弱めるとZの相対的な傾きが強まり、手前に流れる力が逆に増してしまうため）。
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -11, 1.2) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
// コインが密集した状態での接触解決を収束させやすくし、着地後の微振動（スリープしきれず揺れ続ける）を抑える
// 25まで上げることで、山の中で静止すべきコイン（プッシャーに触れていない部分）が
// 確実にスリープ状態へ移行し、着地後の微振動が収まることを確認済み
world.solver.iterations = 25;

const matCoin = new CANNON.Material('coin');
const matField = new CANNON.Material('field');
const matPusher = new CANNON.Material('pusher');
const matGem = new CANNON.Material('gem');
// せき止め坂（ゲート）専用のマテリアル。以前は坂もmatFieldを共用していたため、
// 「開けた床の上では滑りやすく・坂ではしっかり食いつく」という宝石に必要な
// 摩擦の使い分けができなかった。坂だけ独立させることで、コイン/ボール（matCoin）側の
// 挙動は数値を据え置いて完全に維持したまま、宝石（matGem）側の坂の摩擦だけ強める。
const matGate = new CANNON.Material('gate');

// 実物の金属コインは落ちてもほぼ跳ねないため、反発係数はさらに0へ近づける
world.addContactMaterial(new CANNON.ContactMaterial(matCoin, matField, { friction: 0.2, restitution: 0.015 }));
world.addContactMaterial(new CANNON.ContactMaterial(matCoin, matCoin, { friction: 0.32, restitution: 0.01 }));
world.addContactMaterial(new CANNON.ContactMaterial(matCoin, matPusher, { friction: 0.3, restitution: 0.01 }));
// コイン・ボール（同じmatCoin）と坂の摩擦は、以前matFieldが担っていた値をそのまま
// 引き継ぐ（ボールの登坂成功率を変えないため、数値は変更していない）
world.addContactMaterial(new CANNON.ContactMaterial(matCoin, matGate, { friction: 0.2, restitution: 0.015 }));
// テツさま実機報告「すごいころがってしまう」への対応（2026-08-12）：床の摩擦が
// 0.04と他パーツ（コイン:0.2）よりも極端に低く、かつ下記allowSleepの都合もあって
// 一度動き出すと際限なく転がり続けていたため、コインに近い値まで引き上げる。
// 坂（matGate）側の摩擦は据え置き、登坂性能への影響を坂の食いつき側で吸収する
// 【㊿】テツさま実機報告「投入直後、不思議な力で縁へぬるぬる滑っていく」への対応。
// 床の摩擦を0.16→0.20へ引き上げ（坂側matGateの摩擦0.6は変更しておらず、坂への
// 到達後の登坂性能には影響しない想定。ただし0.16→0.24まで検証した範囲では、球体は
// 一定の摩擦を超えると「滑る」から「転がる」へ転じ、転がり始めるとむしろ抵抗が
// 小さくなる場合があると判明したため、摩擦だけに頼らずlinearDampingも併用する）
world.addContactMaterial(new CANNON.ContactMaterial(matGem, matField, { friction: 0.20, restitution: 0.01 }));
world.addContactMaterial(new CANNON.ContactMaterial(matGem, matCoin, { friction: 0.15, restitution: 0.02 }));
world.addContactMaterial(new CANNON.ContactMaterial(matGem, matPusher, { friction: 0.15, restitution: 0.01 }));
world.addContactMaterial(new CANNON.ContactMaterial(matGem, matGate, { friction: 0.6, restitution: 0.01 }));

// ---------- 見た目のマテリアル ----------
// 床はバカラのディーラーテーブルを模した深緑のフェルト＋白のピンストライプ＋トランプの
// マーク（♠♥♦♣）をCanvasTextureでプロシージャル生成（テツさま指示によりワイン色ベースから
// 変更）。外周の金の二重ピンストライプは高級感の定石として踏襲。中央の穴を囲む白い
// 放射状の弧はバカラのレイアウト線を思わせる装飾。コインの視認性を損なわないよう、
// 模様はごく低いコントラストに抑えている。
// 【2026-08-13：㊸ テツさま指示】「床はほぼ完全再現でいい」との許可を受けて、実物の
// ルーレットテーブル同様の0/00・1〜36（赤黒）・2:1・ダズン・Passe/Manque/Rouge/Noir等の
// ベッティングレイアウトをそのまま焼き込む。実物の赤/黒の数字配列に準拠。
const ROULETTE_RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

// ベッティングレイアウト一式（0/00・数字グリッド・2:1・ダズン2段・上下のPasse/Manque等）を
// ローカル原点(x0,y0)〜(x0+w, y0+h)の矩形内に描画する。呼び出し側でctx.rotateしてから
// 呼ぶことで、模様全体を斜めに焼き込める。
function drawRouletteLayout(ctx, x0, y0, w, h) {
  const rowH = { edge: h * 0.13, dozen: h * 0.11, numbers: h * 0.44 };
  const colUnit = w / 14.2;
  const zeroW = colUnit * 1.3, numW = colUnit * 12, twoToOneW = colUnit * 0.9;
  const numX0 = x0 + zeroW, twoToOneX0 = numX0 + numW;

  const cellText = (text, cx, cy, size, color) => {
    ctx.font = `700 ${size}px Georgia, "Hiragino Mincho ProN", serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy);
  };
  const cellStroke = (cx, cy, cw, ch) => {
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 1.3;
    ctx.strokeRect(cx, cy, cw, ch);
  };
  const drawEdgeRow = (bandY, bandH, labels, colors) => {
    const cw = w / labels.length;
    labels.forEach((lab, i) => {
      const cx = x0 + cw * i;
      cellStroke(cx, bandY, cw, bandH);
      cellText(lab, cx + cw / 2, bandY + bandH / 2, lab.length > 2 ? 15 : 20, colors[i]);
    });
  };
  const drawDozenRow = (bandY, bandH) => {
    const cw = numW / 3;
    ['1st 12', '2nd 12', '3rd 12'].forEach((lab, i) => {
      const cx = numX0 + cw * i;
      cellStroke(cx, bandY, cw, bandH);
      cellText(lab, cx + cw / 2, bandY + bandH / 2, 16, 'rgba(255,255,255,0.8)');
    });
    cellStroke(x0, bandY, zeroW, bandH);
    cellStroke(twoToOneX0, bandY, twoToOneW, bandH);
  };

  let y = y0;
  drawEdgeRow(y, rowH.edge, ['PASSE', 'MANQUE', '◆', '◆', 'ROUGE', 'NOIR'],
    ['#f4f1ff', '#f4f1ff', '#e8532f', '#141413', '#e8532f', '#141413']);
  y += rowH.edge;
  drawDozenRow(y, rowH.dozen);
  y += rowH.dozen;

  {
    const bandY = y, bandH = rowH.numbers, rowHNum = bandH / 3;
    cellStroke(x0, bandY, zeroW, bandH);
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(x0 + zeroW / 2, bandY); ctx.lineTo(x0 + zeroW / 2, bandY + bandH); ctx.stroke();
    cellText('0', x0 + zeroW * 0.25, bandY + bandH / 2, 19, '#e8c876');
    cellText('00', x0 + zeroW * 0.75, bandY + bandH / 2, 15, '#e8c876');

    const colW = numW / 12;
    for (let c = 1; c <= 12; c++) {
      const colX = numX0 + colW * (c - 1);
      [3 * c, 3 * c - 1, 3 * c - 2].forEach((n, r) => {
        const cellY = bandY + rowHNum * r;
        cellStroke(colX, cellY, colW, rowHNum);
        cellText(String(n), colX + colW / 2, cellY + rowHNum / 2, 21, ROULETTE_RED_NUMBERS.has(n) ? '#e8532f' : '#f4f1ff');
      });
    }
    for (let r = 0; r < 3; r++) {
      const cellY = bandY + rowHNum * r;
      cellStroke(twoToOneX0, cellY, twoToOneW, rowHNum);
      cellText('2:1', twoToOneX0 + twoToOneW / 2, cellY + rowHNum / 2, 13, 'rgba(255,255,255,0.7)');
    }
    y += bandH;
  }

  drawDozenRow(y, rowH.dozen);
  y += rowH.dozen;
  drawEdgeRow(y, rowH.edge, ['1 - 18', 'EVEN', '◆', '◆', 'ODD', '19 - 36'],
    ['#f4f1ff', '#f4f1ff', '#e8532f', '#141413', '#f4f1ff', '#f4f1ff']);
}

function createFloorTexture() {
  const W = 1536, H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // ベース：深緑のフェルト、縁は暗く沈める（ヴィネット）。
  // テツさま指示（2026-08-12）で「もう少し深めの緑」に調整（各段をさらに暗く）
  const bg = ctx.createRadialGradient(W / 2, H * 0.44, H * 0.12, W / 2, H * 0.5, W * 0.62);
  bg.addColorStop(0, '#0c3524');
  bg.addColorStop(0.55, '#082017');
  bg.addColorStop(1, '#020a07');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // フェルトの織り目（極薄の斜線ノイズ）
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
  ctx.lineWidth = 1;
  for (let x = -H; x < W; x += 6) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + H, H);
    ctx.stroke();
  }

  // 【2026-08-13：㊸ テツさま指示】「床はほぼ完全再現でいい」→ ㊷で数字を敷き詰めずに
  // 留めていた抽象グリッドをやめ、実物同様の0/00・1〜36・2:1・ダズン等のベッティング
  // レイアウトをそのまま焼き込む。さらに「まっすぐ描画するのでは無く斜めに映写する
  // ように」との指示で、模様（罫線・数字）のブロック全体を14度回転させて斜めに配置する。
  // ゲームはOrbitControlsでカメラを自由に回せる仕様のため、カメラ側の角度を変える方式や
  // 疑似遠近感を焼き込む方式だと視点によって見え方が破綻する。そのためテクスチャ内で
  // 模様そのものを回転させる方式（どの角度から見ても常に同じ「斜め」）を採用した。
  const cx = W / 2, cy = H * 0.53;
  // 【㊻ テツさま指示】「床の模様をもっと拡大して（このスペースに収まらなくていい）」
  // を受け、0.62/0.46→1.05/0.85へ大幅拡大。金の縁取りより外側にはみ出す形になるが、
  // Canvas描画は自身の範囲外を自動的に切り捨てるだけなのでエラー等は発生しない
  const gridW = W * 1.05, gridH = H * 0.85;
  const gridX0 = cx - gridW / 2, gridY0 = cy - gridH / 2;
  const FLOOR_PATTERN_ANGLE = 14 * Math.PI / 180;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(FLOOR_PATTERN_ANGLE);
  ctx.translate(-cx, -cy);
  drawRouletteLayout(ctx, gridX0, gridY0, gridW, gridH);
  ctx.restore();
  // 中央の穴（投入口の存在感を保つ飾り罫）は模様の回転に巻き込まず、常に正円のまま
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 92, 0, Math.PI * 2);
  ctx.stroke();
  // 実物のテーブル縁にある真鍮スタッド（金の丸鋲）を模した装飾を、外周の金の縁取りに
  // 沿って等間隔に配置
  const studInset = 26;
  const studR = 6;
  ctx.fillStyle = '#f3d98b';
  const studPerimeter = [];
  const studCountX = 11, studCountY = 7;
  for (let i = 0; i < studCountX; i++) {
    const x = studInset + ((W - studInset * 2) / (studCountX - 1)) * i;
    studPerimeter.push([x, studInset], [x, H - studInset]);
  }
  for (let j = 1; j < studCountY - 1; j++) {
    const y = studInset + ((H - studInset * 2) / (studCountY - 1)) * j;
    studPerimeter.push([studInset, y], [W - studInset, y]);
  }
  for (const [sx, sy] of studPerimeter) {
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, studR);
    g.addColorStop(0, '#fff6da');
    g.addColorStop(0.6, '#d9b65c');
    g.addColorStop(1, '#8a6a1f');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, studR, 0, Math.PI * 2);
    ctx.fill();
  }

  // トランプのマーク（♠♥♦♣、上品なワンポイント装飾として四隅寄りに1つずつ）
  ctx.font = '600 64px Georgia, "Hiragino Mincho ProN", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
  const suits = ['♠', '♥', '♦', '♣'];
  const suitPositions = [
    [W * 0.16, H * 0.18], [W * 0.84, H * 0.18],
    [W * 0.16, H * 0.86], [W * 0.84, H * 0.86],
  ];
  suits.forEach((s, i) => {
    ctx.fillText(s, suitPositions[i][0], suitPositions[i][1]);
  });

  // 外周の二重金ピンストライプ（ゲーミングテーブルの縁取り。金×緑の組み合わせを踏襲）
  const inset1 = 18, inset2 = 34;
  ctx.strokeStyle = '#d9b65c';
  ctx.lineWidth = 5;
  ctx.strokeRect(inset1, inset1, W - inset1 * 2, H - inset1 * 2);
  ctx.strokeStyle = 'rgba(217, 182, 92, 0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(inset2, inset2, W - inset2 * 2, H - inset2 * 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

// 壁用のダークウッド調テクスチャ（テツさま指示：高級感のある暗めの木材＋軽い光沢）。
// マホガニー寄りの濃い茶色地に、細い縦筋を多数重ねてランダムな木目を表現する。
// テツさま指示（2026-08-12・2回目）で「もっと深めの黒に」さらに一段暗く調整。
// ベースがほぼ黒に近づいた分、明るい木目の筋のコントラストをもう一段強めて、
// 真っ黒一色に潰れないようにしている。
function createWoodTexture() {
  const W = 512, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, W, 0);
  bg.addColorStop(0, '#0a0605');
  bg.addColorStop(0.5, '#100907');
  bg.addColorStop(1, '#080403');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * W;
    const dark = Math.random() < 0.5;
    ctx.strokeStyle = dark
      ? `rgba(2, 1, 1, ${0.05 + Math.random() * 0.07})`
      : `rgba(110, 68, 38, ${0.09 + Math.random() * 0.13})`;
    ctx.lineWidth = 0.6 + Math.random() * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(
      x + (Math.random() - 0.5) * 30, H * 0.33,
      x + (Math.random() - 0.5) * 30, H * 0.66,
      x + (Math.random() - 0.5) * 20, H
    );
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  tex.anisotropy = 4;
  return tex;
}

// ストッパー（せき止め傾斜）用のゴールド×ダイヤ柄テクスチャ。単色ベタ塗りから、
// 床・ルーレットと調和する金の質感に刷新（テツさま指示：ストッパーのデザインも高級感を）
function createGateTexture() {
  const W = 512, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#f3d98b');
  bg.addColorStop(0.5, '#caa153');
  bg.addColorStop(1, '#7a5a1a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // 中央にダイヤ柄のライン装飾
  ctx.strokeStyle = 'rgba(58, 34, 10, 0.5)';
  ctx.lineWidth = 3;
  const step = 48;
  for (let x = -H; x < W + H; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + H / 2, H / 2);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + step / 2, 0);
    ctx.lineTo(x + step / 2 - H / 2, H / 2);
    ctx.lineTo(x + step / 2, H);
    ctx.stroke();
  }
  // 上下の縁にワインレッドの引き締めライン
  ctx.fillStyle = '#5a0f1a';
  ctx.fillRect(0, 0, W, 6);
  ctx.fillRect(0, H - 6, W, 6);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(4, 1);
  return tex;
}

const floorMat = new THREE.MeshStandardMaterial({ map: createFloorTexture(), color: 0xffffff, roughness: 0.88, metalness: 0.08 });
// 暗めのダークウッド（軽い光沢）に変更。金属ではないのでmetalnessは低めに保つ
const wallMat = new THREE.MeshStandardMaterial({ map: createWoodTexture(), color: 0xffffff, roughness: 0.38, metalness: 0.08 });
const pusherMat = new THREE.MeshStandardMaterial({ color: 0xd83a3a, roughness: 0.4, metalness: 0.4 });
const trayMat = new THREE.MeshStandardMaterial({ color: 0x160709, roughness: 0.9, metalness: 0.1 });
// 壁の縁（上端・下端・縦の角）の金トリム装飾（物理判定なし）
const trimMat = new THREE.MeshStandardMaterial({ color: 0xd9b65c, metalness: 0.75, roughness: 0.28, emissive: 0x2a1c05 });
function addWallTrim(width, depth, px, pz, py) {
  const trim = new THREE.Mesh(new THREE.BoxGeometry(width, 0.05, depth), trimMat);
  trim.position.set(px, py, pz);
  trim.castShadow = true;
  scene.add(trim);
}
// 壁の縦の角に立てる細い金の縁取り柱
function addVerticalTrim(height, px, pz) {
  const trim = new THREE.Mesh(new THREE.BoxGeometry(0.05, height, 0.05), trimMat);
  trim.position.set(px, height / 2, pz);
  trim.castShadow = true;
  scene.add(trim);
}

function addStaticBox(sx, sy, sz, px, py, pz, mesh, material) {
  const geo = new THREE.BoxGeometry(sx * 2, sy * 2, sz * 2);
  const m = new THREE.Mesh(geo, material);
  m.position.set(px, py, pz);
  m.receiveShadow = true;
  m.castShadow = true;
  scene.add(m);

  const body = new CANNON.Body({ mass: 0, material: matField });
  body.addShape(new CANNON.Box(new CANNON.Vec3(sx, sy, sz)));
  body.position.set(px, py, pz);
  world.addBody(body);
  return { mesh: m, body };
}

// フィールド床（幅はFIELD_HALF_Xの再ワイド化に合わせて3.9→5.07。
// 奥行きは得点ラインEDGE_Z_FRONTでちょうど途切れるようにしている。
// 以前は床がEDGE_Z_FRONTより先まで伸びていたため、GET演出で落下するコインが
// 床の中にめり込んで見える不具合があった）
const FLOOR_HALF_X = 5.07;
addStaticBox(FLOOR_HALF_X, 0.2, 3.3, 0, -0.2, -0.1, null, floorMat);
// 奥の壁
addStaticBox(FLOOR_HALF_X, 1.0, 0.15, 0, 0.8, WALL_Z_BACK, null, wallMat);
// 左右の壁（床の外側にちょうど接する位置）
addStaticBox(0.15, 1.0, 3.55, -(FLOOR_HALF_X + 0.15), 0.8, 0, null, wallMat);
addStaticBox(0.15, 1.0, 3.55, FLOOR_HALF_X + 0.15, 0.8, 0, null, wallMat);
// 壁上端の金トリム
addWallTrim(FLOOR_HALF_X * 2 - 0.05, 0.17, 0, WALL_Z_BACK, 1.78);
addWallTrim(0.17, 3.57, -(FLOOR_HALF_X + 0.15), 0, 1.78);
addWallTrim(0.17, 3.57, FLOOR_HALF_X + 0.15, 0, 1.78);
// 壁と床の境目（下端）にも金トリムを追加し、木材の縁取りをより明確にする
addWallTrim(FLOOR_HALF_X * 2 - 0.05, 0.17, 0, WALL_Z_BACK, 0.05);
addWallTrim(0.17, 3.57, -(FLOOR_HALF_X + 0.15), 0, 0.05);
addWallTrim(0.17, 3.57, FLOOR_HALF_X + 0.15, 0, 0.05);
// 奥壁と左右壁が接する縦の角にも金の縁取り柱を追加
addVerticalTrim(1.6, -(FLOOR_HALF_X + 0.15), WALL_Z_BACK);
addVerticalTrim(1.6, FLOOR_HALF_X + 0.15, WALL_Z_BACK);

// 落ちたコインを受ける見た目だけのトレイ（物理なし）
{
  const trayGeo = new THREE.BoxGeometry(7, 0.3, 3);
  const tray = new THREE.Mesh(trayGeo, trayMat);
  tray.position.set(0, -2.2, 5.2);
  tray.receiveShadow = true;
  scene.add(tray);
}

// ---------- コインレール（ルーレット報酬コインの受け皿＋ジャックポットで解放） ----------
// 【2026-08-20 テツさま指摘】単一の透明円柱「コインサイロ」（奥の壁の上）は
// 「宝石の出口みたいになってしまっている」との指摘で撤去。台を取り囲むように、左右の壁
// →奥の壁→反対側の壁、と上端に沿って長く伸びる1本のレールに変更した。狙いは「どこまで
// コインがたまっちゃうんだ！？」というスケール感の期待を煽ること（サイロの約10倍の長さ）。
// 供給源（ルーレット報酬コインのみ）・解放方式（ジャックポットでGET枚数へ直接加算）は
// 変更なし。壁の上端は高さy=1.8（addStaticBoxの壁：半径1.0・中心y=0.8）なので、
// その少し上（RAIL_Y=2.0）にレールを通す。
const RAIL_Y = 2.0;
const RAIL_RADIUS = 0.14;
const RAIL_TUBE_SEGMENTS = 96; // 満タン時のチューブ分割数（表示の滑らかさ）
// 左手前→左奥→右奥→右手前、の順（左手前から溜まり始め、右手前まで到達すると満タン）
const RAIL_PATH_POINTS = [
  new THREE.Vector3(-(FLOOR_HALF_X + 0.15), RAIL_Y, EDGE_Z_FRONT),
  new THREE.Vector3(-(FLOOR_HALF_X + 0.15), RAIL_Y, WALL_Z_BACK),
  new THREE.Vector3(FLOOR_HALF_X + 0.15, RAIL_Y, WALL_Z_BACK),
  new THREE.Vector3(FLOOR_HALF_X + 0.15, RAIL_Y, EDGE_Z_FRONT),
];
// 【デバッグ判明】直線3本を繋いだCurvePath（鋭角の90度コーナー）だと、TubeGeometryの
// Frenet frameがコーナーで破綻し、透過ガラス（transmission）のレンダーパスが内側の
// 金色フィルを隠してしまう不具合が発生した（コーナーを挟んで法線がねじれるのが原因と
// 推測）。滑らかに曲がるCatmullRomCurve3に変更することで解消（見た目も、実物のパイプが
// 角で緩やかに曲がる感じに近づき自然になった）。
const railPath = new THREE.CatmullRomCurve3(RAIL_PATH_POINTS, false, 'centripetal', 0.5);
const TOWER_CAP = 60; // (51)追加修正4の既知課題（ルーレット最大報酬50が頭打ちになる）対策で30→60のまま踏襲
let towerFillTotal = 0;

const TOWER_POUR_INTERVAL = 0.12; // ルーレット報酬をレールへ1枚ずつ注ぐ間隔
let towerPourQueueCount = 0;
let towerPourTimer = 0;

let towerReleaseState = 'idle'; // 'idle' | 'cascading' | 'pouring'
let towerReleaseTimer = 0;
let towerReleaseCascadeStartTotal = 0; // cascading開始時点のtowerFillTotal（ここから0まで線形に減らす）
const RAIL_DRAIN_DURATION = 1.2; // ジャックポット解放時、レールが空になるまでの時間
const TOWER_RELEASE_POUR_INTERVAL = 0.08;
let towerReleasePourQueueCount = 0;
let towerReleasePourTimer = 0;

// 【デバッグ判明・設計変更】当初は透明なガラス管の中に金色フィルが入れ子で入る構成
// だったが、Three.jsのMeshPhysicalMaterial/MeshBasicMaterialいずれの半透明設定でも、
// 内側に同心状に重なる不透明な金色フィルメッシュが完全に隠れてしまう再現性の高い
// 不具合に遭遇した（transmission・アルファ半透明・FrontSide化と試したが解消せず、
// 根本原因は特定しきれなかった）。ガラス管そのものを撤去し、金色のフィルそのものを
// 直接見せる構成に変更（コインが伸びていく様子そのものが主役になるため、これはこれで
// 「どこまでたまるか」の視認性はむしろ良い）。空の状態は「何も見えない細いレール」に
// なるが、これは既存のシャンパングラス・タワー各版とも同様だった「空＝控えめ」という
// 前例を踏襲している。
// レールは壁の上端沿いに台の四方（前寄りの左右コーナー含む）まで長く伸びるため、
// 中央付近の点光源だけでは光が届かない区間が出て、金属マテリアル（envMapなし）が
// 真っ黒に沈んで見えなくなる。envMapを足して局所光源に頼らず常に反射を出す。
const railFillMat = new THREE.MeshStandardMaterial({
  color: 0xf3d98b, metalness: 0.85, roughness: 0.22, emissive: 0x3a2a08,
  envMap: gemEnvTexture, envMapIntensity: 2.4,
});

// 「t=0からtowerFillTotal/TOWER_CAPの割合ぶん」だけの部分TubeGeometryを都度作り直す
// ことで、経路に沿って伸び縮みする様子を表現する（毎フレームではなく、実際に
// towerFillTotalが変化した時だけ呼ばれるので負荷は軽い）
const railFillMesh = new THREE.Mesh(new THREE.BufferGeometry(), railFillMat);
railFillMesh.visible = false;
scene.add(railFillMesh);

function updateTowerFillVisual() {
  const frac = Math.max(0, Math.min(1, towerFillTotal / TOWER_CAP));
  if (frac <= 0.002) {
    railFillMesh.visible = false;
    return;
  }
  railFillMesh.visible = true;
  const segN = Math.max(2, Math.round(RAIL_TUBE_SEGMENTS * frac));
  const pts = [];
  for (let i = 0; i <= segN; i++) {
    pts.push(railPath.getPointAt((i / segN) * frac));
  }
  const fillSubPath = new THREE.CurvePath();
  for (let i = 0; i < pts.length - 1; i++) fillSubPath.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
  const newGeo = new THREE.TubeGeometry(fillSubPath, segN, RAIL_RADIUS, 12, false);
  railFillMesh.geometry.dispose();
  railFillMesh.geometry = newGeo;
}

// ---------- 穴の共通ゴール数（アーチ機構・(54)で使用） ----------
const HOLE_GOAL = 10;

// ---------- せき止め傾斜（跳ね橋のように後端を軸に前が持ち上がる坂） ----------
// 壁でせき止めるのではなく、登り坂にすることで「落ちそうで落ちない」じれったさを出す。
// 後端（プッシャー側）を蝶番として固定し、前端（得点ライン側）が持ち上がることで
// 上り坂になる。平らに滑るだけのコインは坂を登り切れず溜まっていくが、転がる
// ボール（半径が大きく回転できる）は勢いがあれば登り切れる。ボールが得点ラインに
// 到達したタイミングで、坂を平らに戻し（＝せき止めを解除し）、溜まっていたコインを
// 一気に解放する。
const RAMP_HALF_LENGTH = 0.35;
// 薄すぎるとコインが密集して押し込まれた際に1フレームで貫通（すり抜け）しやすくなるため、
// 前回の0.07から厚みを増して物理的な安全マージンを確保
// 「もっと急にしたい・ボールも重く」の要望を受けて再度無人スイープテストを実施。
// 26度は過去の検証通りほぼ登坂不能。今回はボール質量2.0との組み合わせで23度〜24度を
// 比較したところ、23度は3/3成功、24度は1/3成功と明確に差が出たため、23度・質量2.0を
// 最終値に採用（22度・質量1.6の頃より急かつボールも重いが、登坂成功率はむしろ改善）。
// 35度は26度時点で「ほぼ不可能」だった過去データから見て機構が完全に壊れる可能性が
// 極めて高く、今回は試していない。
const RAMP_THICKNESS = 0.07;
const RAMP_BACK_Z = EDGE_Z_FRONT - RAMP_HALF_LENGTH * 2; // 後端（蝶番の位置・固定）
const RAMP_MAX_ANGLE = Math.PI * 23 / 180; // 坂の最大傾斜角（22度→23度）
const GATE_WARNING_DURATION = 1.2; // 光って予告する時間
const GATE_OPEN_DURATION = 2.5;    // 平らに開放している時間（ボール到達時のデフォルト）
const GATE_MOVE_DURATION = 0.4;    // 傾斜が変化するアニメーション時間
const GEM_GATE_OPEN_DURATION = 5.0; // 宝石到達時の開放時間（ボールより長め、テツさま指定）

const gateMat = new THREE.MeshStandardMaterial({ map: createGateTexture(), color: 0xffffff, metalness: 0.65, roughness: 0.28, emissive: 0x000000 });
const gateGeo = new THREE.BoxGeometry(FIELD_HALF_X * 2 - 0.1, RAMP_THICKNESS, RAMP_HALF_LENGTH * 2);
const gateMesh = new THREE.Mesh(gateGeo, gateMat);
gateMesh.castShadow = true;
gateMesh.receiveShadow = true;
scene.add(gateMesh);

const gateShape = new CANNON.Box(new CANNON.Vec3(FIELD_HALF_X - 0.05, RAMP_THICKNESS / 2, RAMP_HALF_LENGTH));
const gateBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matGate });
gateBody.addShape(gateShape);
world.addBody(gateBody);

// frac: 0=平ら（開放中）、1=最大傾斜（せき止め中）。後端を蝶番にした円弧上を中心が動く。
// 【重要】プッシャー(⑯)と同じ理由で、位置・姿勢を直接書き換えるだけでなく
// velocity/angularVelocityも正しく設定する必要がある。cannon-esのキネマティックボディは
// 速度を見て接触応答（乗っているコインを一緒に動かす／スリープ中のコインを起こす）を
// 決めるため、速度が常に0のままだと「見た目だけ動いて物理的には動いていない」状態になり、
// 坂の上のコインが正しく運ばれず、すり抜けの原因になっていた可能性がある。
let gatePrevY = RAMP_THICKNESS / 2 + RAMP_HALF_LENGTH * Math.sin(RAMP_MAX_ANGLE);
let gatePrevZ = RAMP_BACK_Z + RAMP_HALF_LENGTH * Math.cos(RAMP_MAX_ANGLE);
let gatePrevAngle = RAMP_MAX_ANGLE;
function setGateFraction(frac, dt) {
  const angle = RAMP_MAX_ANGLE * frac;
  const centerZ = RAMP_BACK_Z + RAMP_HALF_LENGTH * Math.cos(angle);
  const centerY = RAMP_THICKNESS / 2 + RAMP_HALF_LENGTH * Math.sin(angle);
  if (dt && dt > 0) {
    gateBody.velocity.set(0, (centerY - gatePrevY) / dt, (centerZ - gatePrevZ) / dt);
    gateBody.angularVelocity.set(-(angle - gatePrevAngle) / dt, 0, 0);
  } else {
    gateBody.velocity.set(0, 0, 0);
    gateBody.angularVelocity.set(0, 0, 0);
  }
  gateBody.position.set(0, centerY, centerZ);
  gateBody.quaternion.setFromEuler(-angle, 0, 0);
  gateMesh.position.copy(gateBody.position);
  gateMesh.quaternion.copy(gateBody.quaternion);
  gatePrevY = centerY;
  gatePrevZ = centerZ;
  gatePrevAngle = angle;
}
setGateFraction(1);

let gateState = 'up'; // 'up' | 'warning' | 'opening' | 'open' | 'closing'
let gateTimer = 0;
// 発動中の開放シーケンスで実際に使う開放時間。トリガー元（ボール／宝石）によって
// 異なる長さを指定できるようにするための変数（既定はボールと同じGATE_OPEN_DURATION）。
let gateOpenDuration = GATE_OPEN_DURATION;

function triggerGateRelease(openDuration) {
  if (gateState === 'up') {
    gateState = 'warning';
    gateTimer = 0;
    gateOpenDuration = openDuration !== undefined ? openDuration : GATE_OPEN_DURATION;
  }
}

// ---------- プッシャー（奥の壁際に固定された端から伸縮するテレスコピック構造） ----------
const PUSHER_HALF_HEIGHT = 0.14;
// メッシュは奥行き1（単位長さ）で作り、毎フレームscale.zで伸縮させる
const pusherGeo = new THREE.BoxGeometry(FIELD_HALF_X * 2 - 0.1, PUSHER_HALF_HEIGHT * 2, 1);
const pusherMesh = new THREE.Mesh(pusherGeo, pusherMat);
pusherMesh.castShadow = true;
pusherMesh.receiveShadow = true;
scene.add(pusherMesh);

const pusherShape = new CANNON.Box(new CANNON.Vec3(FIELD_HALF_X - 0.05, PUSHER_HALF_HEIGHT, PUSHER_HALF_LEN_CENTER));
const pusherBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matPusher });
pusherBody.addShape(pusherShape);
// t=0でhalfLen=CENTERになるようsin波を使うため、初期位置もCENTERに合わせておく
pusherBody.position.set(0, PUSHER_HALF_HEIGHT, PUSHER_BACK_Z + PUSHER_HALF_LEN_CENTER);
world.addBody(pusherBody);

// ---------- プッシャー先端の穴アーチ（(54)、Step5のスライドドア＋床中央の穴を統合置換） ----------
// テツさまが実物のコインプッシャー機を見学して着想（参考写真：デザイン関係/8.25見学結果/IMG_6907.HEIC＝
// プッシャー手前のヘリに「START」と書かれたアーチ状の穴が横並びに配置されている）。
// 床の中央の穴・Step5のスライドドア（独立周期の開閉）はどちらも廃止し、
// 「プッシャー先端＝コインの落下境界そのもの」にアーチ状の穴を新設する方式に一本化。
// アーチはプッシャー本体に固定され、往復運動（伸縮）と一体で前後に動く。
// 開閉タイマーは持たない＝常時「通過可能」。実際にアーチの位置を通ったコインだけを
// 1/10としてカウントするB方式（アーチの左右からこぼれ落ちたコインは通常得点にはなるが
// このカウントには入らない）。Ver1では中央に1つだけ実装（Ver2以降でゲーム種類分に拡張予定）。
const PUSHER_ARCH_RADIUS = 0.42;
const PUSHER_ARCH_LEG_HEIGHT = 0.4;
// 判定Y範囲（コインの絶対Y座標）。「くぐる」対象は主に床面付近のヘリのコイン
// （プッシャー先端に押されて前へ出る瞬間はY≈コイン厚み程度と低い）のため、
// 床面ぎりぎりから山の高さも見込んだ範囲にする
const PUSHER_ARCH_Y_MIN = -0.02;
const PUSHER_ARCH_Y_MAX = 0.9;

const pusherArchGroup = new THREE.Group();

// アーチ本体（トーラスの半円＝門型フレーム、参考写真の金属アーチを再現）
// 2026-08-25追加指示：アーチ下の黒い穴デカールは不要（削除済み）。
// アーチを通ったコインは吸い込み演出をせず、そのまま床へ普通に落ちる。
// TorusGeometryはXY平面上（Z軸が法線）に構築され、arc=PIだと角度0(X+)→π/2(Y+)→π(X-)を
// 通る上向きの半円になるため、追加の回転は不要
const archTorusGeo = new THREE.TorusGeometry(PUSHER_ARCH_RADIUS, 0.045, 12, 24, Math.PI);
const archMat = new THREE.MeshStandardMaterial({ color: 0xffcc33, metalness: 0.7, roughness: 0.3, emissive: 0x553300 });
const pusherArchFrame = new THREE.Mesh(archTorusGeo, archMat);
pusherArchFrame.position.y = PUSHER_ARCH_LEG_HEIGHT;
pusherArchFrame.castShadow = true;
pusherArchGroup.add(pusherArchFrame);
// アーチの脚（左右の柱、半円の両端からプッシャー天面まで下ろす）
const archLegGeo = new THREE.CylinderGeometry(0.045, 0.045, PUSHER_ARCH_LEG_HEIGHT, 10);
const archLegL = new THREE.Mesh(archLegGeo, archMat);
archLegL.position.set(-PUSHER_ARCH_RADIUS, PUSHER_ARCH_LEG_HEIGHT / 2, 0);
pusherArchGroup.add(archLegL);
const archLegR = new THREE.Mesh(archLegGeo, archMat);
archLegR.position.set(PUSHER_ARCH_RADIUS, PUSHER_ARCH_LEG_HEIGHT / 2, 0);
pusherArchGroup.add(archLegR);

scene.add(pusherArchGroup);

// ---------- コイン管理 ----------
// テツさま指示（2026-08-13、コイン参考画像）：豪華なカジノトークン風の彫刻デザインに
// したいが「デザインより負荷優先」とのことなので、ジオメトリ・当たり判定は一切変更せず、
// 起動時に一度だけCanvasTextureを焼いてマテリアルに貼るだけにする（実行時コストはゼロ、
// 200枚同時描画してもテクスチャサンプリングのコストは変わらない）。参考画像には実在の
// カジノブランドの文字が写っていたため、意匠（唐草模様の縁取り＋ドットのリング＋中央の
// 大きなモノグラム＋アーチ状の文字）だけ踏襲し、文字はこのゲーム用の汎用的なもの
// （"MEDAL" / "CASINO TOKEN"）に置き換えている。
function drawArcText(ctx, text, cx, cy, radius, startAngle, endAngle, color, fontPx) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `700 ${Math.round(fontPx)}px Georgia, "Hiragino Mincho ProN", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const step = (endAngle - startAngle) / (text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const a = startAngle + step * (i + 1);
    ctx.save();
    ctx.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(text[i], 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

// ---------- コインの浮き彫り表現（法線マップ） ----------
// 【2026-08-23】実機フィードバック「キラキラ感がない、プラスチックのメダルに見える」
// 「Mの平面印刷が逆効果」への対応（参考画像2枚＝デザイン関係/コイン　参考/ を採用）。
// 参考画像はいずれも文字・唐草模様が実際に凹凸のある浮き彫り（エンボス）だった。
// ジオメトリ・当たり判定は増やさず（テツさま既存方針「デザインより負荷優先」を維持）、
// 起動時に一度だけ法線マップを焼いてMeshStandardMaterialへ適用することで、
// 見た目だけ凹凸をライティングに反映させる（実行時コストはdiffuseテクスチャと同じ＝ゼロ）。
// 手順：①白黒の「高さマップ」に浮き彫りにしたい図形（M・アーチ文字・唐草・ドット・縁の
// ギザギザ）だけをdiffuseテクスチャと全く同じ座標で描く　②中央差分（Sobel相当）で
// 法線ベクトルを計算しRGBへエンコード　③金・銀コインで共有適用する（凹凸の形は共通、
// 色のみdiffuse側で別テクスチャを使い分けている既存方式はそのまま）。
function heightCanvasToNormalMap(heightCanvas, strength) {
  const w = heightCanvas.width, h = heightCanvas.height;
  const heightData = heightCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const getH = (x, y) => {
    const cx = x < 0 ? 0 : (x >= w ? w - 1 : x);
    const cy = y < 0 ? 0 : (y >= h ? h - 1 : y);
    return heightData[(cy * w + cx) * 4] / 255;
  };
  const encode = (n) => Math.max(0, Math.min(255, Math.round((n * 0.5 + 0.5) * 255)));
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = w;
  normalCanvas.height = h;
  const nctx = normalCanvas.getContext('2d');
  const outImg = nctx.createImageData(w, h);
  const out = outImg.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (getH(x + 1, y) - getH(x - 1, y)) * strength;
      const dy = (getH(x, y + 1) - getH(x, y - 1)) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const idx = (y * w + x) * 4;
      out[idx] = encode(-dx / len);
      out[idx + 1] = encode(-dy / len);
      out[idx + 2] = encode(1 / len);
      out[idx + 3] = 255;
    }
  }
  nctx.putImageData(outImg, 0, 0);
  return normalCanvas;
}

function createCoinHeightCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = COIN_ATLAS_W;
  canvas.height = COIN_ATLAS_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080'; // 中立の高さ（凹凸なし）
  ctx.fillRect(0, 0, COIN_ATLAS_W, COIN_ATLAS_H);

  const H = COIN_ATLAS_FACE;
  const cx = H / 2, cy = H / 2;
  // diffuse側と全く同じ-90度回転補正（座標を完全に一致させるため）
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 2);
  ctx.translate(-cx, -cy);

  // 外周の縁を一段高くする（実物コインのリム）
  ctx.fillStyle = '#a8a8a8';
  ctx.beginPath();
  ctx.arc(cx, cy, H * 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#808080';
  ctx.beginPath();
  ctx.arc(cx, cy, H * 0.47, 0, Math.PI * 2);
  ctx.fill();

  // 唐草模様（diffuseと同じ形状・座標で、明るく描いて浮き彫りにする）
  const outerR = H * 0.465, innerR = H * 0.365;
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 3;
  const swirlCount = 20;
  for (let i = 0; i < swirlCount; i++) {
    const a = (i / swirlCount) * Math.PI * 2;
    const sx = cx + Math.cos(a) * ((outerR + innerR) / 2);
    const sy = cy + Math.sin(a) * ((outerR + innerR) / 2);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(a + Math.PI / 2);
    ctx.beginPath();
    ctx.arc(0, 0, (outerR - innerR) / 2, 0, Math.PI * 1.5);
    ctx.stroke();
    ctx.restore();
  }
  // ビーズ（ドット）のリング
  ctx.fillStyle = '#f0f0f0';
  const dotCount = 44;
  for (let i = 0; i < dotCount; i++) {
    const a = (i / dotCount) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR, H * 0.008, 0, Math.PI * 2);
    ctx.fill();
  }

  // 中央のモノグラム「M」（一番高く盛り上げる）
  ctx.fillStyle = '#ffffff';
  ctx.font = `italic 700 ${Math.round(H * 0.32)}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('M', cx, cy + H * 0.01);

  drawArcText(ctx, 'MEDAL', cx, cy, innerR * 0.84, Math.PI * 1.2, Math.PI * 1.8, '#f0f0f0', H * 0.03);
  ctx.font = `600 ${Math.round(H * 0.028)}px Georgia, serif`;
  ctx.fillStyle = '#f0f0f0';
  ctx.fillText('CASINO', cx, cy + H * 0.255);
  ctx.fillText('TOKEN', cx, cy + H * 0.3);
  ctx.restore();

  // 側面（ギザギザのリード加工）：縦縞を軽い凹凸として焼く
  const ex0 = COIN_ATLAS_FACE;
  const ew = COIN_ATLAS_EDGE_W, eh = COIN_ATLAS_EDGE_H;
  ctx.fillStyle = '#808080';
  ctx.fillRect(ex0, 0, ew, COIN_ATLAS_H);
  for (let x = 0; x < ew; x += 6) {
    ctx.fillStyle = (Math.floor(x / 6) % 2 === 0) ? '#606060' : '#a8a8a8';
    ctx.fillRect(ex0 + x, 0, 3, eh);
  }

  // 輪郭が硬いとノーマルマップがジャギーになりやすいため、全体を軽くぼかす
  // （同一canvasへの自己描画は環境依存の挙動があるため、別canvasへ描き直す）
  const blurred = document.createElement('canvas');
  blurred.width = COIN_ATLAS_W;
  blurred.height = COIN_ATLAS_H;
  const bctx = blurred.getContext('2d');
  bctx.filter = 'blur(2px)';
  bctx.drawImage(canvas, 0, 0);
  return blurred;
}

// 【㊵ FPS改善】㊴では側面・上面・底面を別マテリアル（配列）にしたため、コイン1個
// あたりの描画コールが最大3倍になり200枚投入時のFPSが12〜13→10へ悪化した。
// 1枚のテクスチャに「顔面デザイン」と「側面の縞模様」を両方焼き込み、ジオメトリの
// UVをこのアトラス内の対応領域へ張り替えることで、マテリアルを1個（=描画コール1回）
// に戻す。
const COIN_ATLAS_FACE = 512;   // 顔面デザインの一辺（正方形）
const COIN_ATLAS_EDGE_W = 256; // 側面帯の幅（周方向に伸びる）
const COIN_ATLAS_EDGE_H = 128; // 側面帯の高さ（コインの厚み方向。薄いので低解像度で十分）
const COIN_ATLAS_W = COIN_ATLAS_FACE + COIN_ATLAS_EDGE_W;
const COIN_ATLAS_H = COIN_ATLAS_FACE;

const coinNormalMap = new THREE.CanvasTexture(heightCanvasToNormalMap(createCoinHeightCanvas(), 3.5));
coinNormalMap.anisotropy = 4;

function createCoinAtlasTexture(isGold) {
  const canvas = document.createElement('canvas');
  canvas.width = COIN_ATLAS_W;
  canvas.height = COIN_ATLAS_H;
  const ctx = canvas.getContext('2d');
  const pal = isGold
    ? { d: '#7a4e12', m: '#e8b23a', l: '#fff0c2', line: '#4a2e08', text: '#3a2205' }
    : { d: '#5b6270', m: '#c7cedb', l: '#f5f8fc', line: '#33383f', text: '#22262b' };

  // ---- 顔面デザイン（アトラス左側 512x512 の正方領域） ----
  const H = COIN_ATLAS_FACE;
  const cx = H / 2, cy = H / 2;

  // 【回転バグ修正】CylinderGeometryのキャップ面UVは頂点座標が(sinθ,cosθ)、UVが
  // (cosθ,sinθ)という順序の違いがあり、素直に描いたCanvasがコイン上で時計回りに
  // 90度回転して見えてしまっていた（実機スクリーンショットで確認済み）。顔面部分の
  // 描画だけをあらかじめ-90度回転させることで打ち消す。
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 2);
  ctx.translate(-cx, -cy);

  const bg = ctx.createRadialGradient(cx, cy, H * 0.04, cx, cy, H * 0.5);
  bg.addColorStop(0, pal.l);
  bg.addColorStop(0.55, pal.m);
  bg.addColorStop(1, pal.d);
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, H * 0.5, 0, Math.PI * 2);
  ctx.fill();

  // 外周の唐草模様（渦巻きを円周に沿って並べる）
  const outerR = H * 0.465, innerR = H * 0.365;
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 2;
  const swirlCount = 20;
  for (let i = 0; i < swirlCount; i++) {
    const a = (i / swirlCount) * Math.PI * 2;
    const sx = cx + Math.cos(a) * ((outerR + innerR) / 2);
    const sy = cy + Math.sin(a) * ((outerR + innerR) / 2);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(a + Math.PI / 2);
    ctx.beginPath();
    ctx.arc(0, 0, (outerR - innerR) / 2, 0, Math.PI * 1.5);
    ctx.stroke();
    ctx.restore();
  }
  // ビーズ（ドット）のリング
  ctx.fillStyle = pal.line;
  const dotCount = 44;
  for (let i = 0; i < dotCount; i++) {
    const a = (i / dotCount) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR, H * 0.006, 0, Math.PI * 2);
    ctx.fill();
  }

  // 中央のモノグラム「M」
  ctx.fillStyle = pal.text;
  ctx.font = `italic 700 ${Math.round(H * 0.32)}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('M', cx, cy + H * 0.01);

  // アーチ状の文字（上）＋直線の文字（下）。実在ブランド名は使わず汎用表記にしている
  drawArcText(ctx, 'MEDAL', cx, cy, innerR * 0.84, Math.PI * 1.2, Math.PI * 1.8, pal.text, H * 0.03);
  ctx.font = `600 ${Math.round(H * 0.028)}px Georgia, serif`;
  ctx.fillText('CASINO', cx, cy + H * 0.255);
  ctx.fillText('TOKEN', cx, cy + H * 0.3);
  ctx.restore();

  // ---- 側面の縞模様（アトラス右側 256x128 の領域。円周に沿って繰り返す縦縞を
  // あらかじめ焼き込んでおく。テクスチャのrepeatは使わない＝アトラス内の他の領域を
  // 巻き込んでしまうため） ----
  const ex0 = COIN_ATLAS_FACE;
  const ew = COIN_ATLAS_EDGE_W, eh = COIN_ATLAS_EDGE_H;
  const egrad = ctx.createLinearGradient(0, 0, 0, eh);
  egrad.addColorStop(0, pal.m);
  egrad.addColorStop(1, pal.d);
  ctx.fillStyle = egrad;
  ctx.fillRect(ex0, 0, ew, eh);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  for (let x = 0; x < ew; x += 6) {
    ctx.beginPath();
    ctx.moveTo(ex0 + x, 0);
    ctx.lineTo(ex0 + x, eh);
    ctx.stroke();
  }
  // アトラスの余白（側面帯の下の未使用部分）は地の色で塗って隙間が見えないようにする
  ctx.fillStyle = pal.d;
  ctx.fillRect(ex0, eh, ew, COIN_ATLAS_H - eh);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

const coinGeo = new THREE.CylinderGeometry(COIN_RADIUS, COIN_RADIUS, COIN_HEIGHT, 28);
// CylinderGeometryは既定で[側面, 上面, 底面]の3グループを持ち、マテリアル配列を
// 使うとグループ数ぶん描画コールが発生する。アトラステクスチャ＋UV張り替えにより
// 単一マテリアルへ統合し、グループを消して描画コールを1個に戻す（詳細はspec.md㊵）。
(function remapCoinUVsToAtlas(geo) {
  const uv = geo.attributes.uv;
  const index = geo.index;
  const faceScaleU = COIN_ATLAS_FACE / COIN_ATLAS_W;
  const edgeU0 = COIN_ATLAS_FACE / COIN_ATLAS_W;
  const edgeUScale = COIN_ATLAS_EDGE_W / COIN_ATLAS_W;
  const edgeVScale = COIN_ATLAS_EDGE_H / COIN_ATLAS_H;
  for (const g of geo.groups) {
    const isCap = g.materialIndex !== 0; // 0=側面, 1=上面, 2=底面（CylinderGeometryの生成順）
    const seen = new Set();
    for (let i = g.start; i < g.start + g.count; i++) {
      const vi = index.getX(i);
      if (seen.has(vi)) continue;
      seen.add(vi);
      const u = uv.getX(vi), v = uv.getY(vi);
      if (isCap) {
        uv.setXY(vi, u * faceScaleU, v);
      } else {
        uv.setXY(vi, edgeU0 + u * edgeUScale, v * edgeVScale);
      }
    }
  }
  uv.needsUpdate = true;
  geo.clearGroups();
})(coinGeo);
// 以前はmetalness:1.0にすると環境マップがないシーンで光の当たらない面が真っ黒に
// 沈んでしまうため0.88/0.92止まりにしていたが、環境マップ（scene.environment）を
// 導入したことでこの制約が解消されたため、宝飾品に近い輝きになるよう1.0近くまで上げた。
// 【2026-08-23】normalMap追加＋roughnessを僅かに下げ、参考画像同様の鏡面に近い輝きへ寄せた
const coinMatGold = new THREE.MeshStandardMaterial({
  map: createCoinAtlasTexture(true), metalness: 0.97, roughness: 0.1,
  normalMap: coinNormalMap, normalScale: new THREE.Vector2(1.4, 1.4),
});
const coinMatSilver = new THREE.MeshStandardMaterial({
  map: createCoinAtlasTexture(false), metalness: 0.98, roughness: 0.08,
  normalMap: coinNormalMap, normalScale: new THREE.Vector2(1.4, 1.4),
});

// ---------- 大当たりコインタワー（Step3、2026-08-22）----------
// 【注意】既存の「コインレール」（TOWER_CAP・towerFillTotal・towerReleaseState等、
// 変数名にtowerを含むがルーレット報酬の受け皿→JPで解放する別システム、616行目付近）
// とは完全に別物。混同を避けるため、こちらの変数・関数はすべて`jpTower`プレフィックスで統一する。
// 誕生石を1個入手するかJPスロットに外れるたびに1段ずつ育ち（最大20段）、JPスロットの
// 目押し成功判定を緩くする「救済」システム。プッシャーを囲むように6本配置し、段階に応じて
// 積み上がったコイン枚数の見た目を変える。パフォーマンス最優先のため物理演算は使わず、
// 静的な装飾メッシュの表示/非表示だけで表現する（コインレール等、過去の増分と同じ簡略化方針）。
const JP_TOWER_MAX_STAGE = 20;   // タワーの最大段階（テツさま「肌感覚で20段階くらい」）
const JP_TOWER_MAX_COINS = 22;   // 1本あたりの最大積み上げ枚数（見た目のみ・物理なし）
let jpTowerStage = 0;

// 【判断した点・正直な記録】当初は壁の外側4隅＋奥2本（プッシャーを完全に囲む六角形）で
// 配置したが、Playwrightのスクリーンショットで確認したところ、奥の2本（壁の真後ろ）は
// 既定カメラから壁に隠れて全く見えないことが判明した（「タワーが育つ様子を視覚的に見せたい」
// という要望の核心に反するため、これは看過できない不具合と判断し設計変更した）。
// 左右に3本ずつ（壁の外側、X=±6.8で奥行きをずらして並べる）配置に変更し、既定カメラから
// 常に6本すべてが視認できることをスクリーンショットで確認済み。
const JP_TOWER_POSITIONS = [
  { x: -6.8, z: 2.0 },
  { x: -6.8, z: 0.0 },
  { x: -6.8, z: -2.0 },
  { x: 6.8, z: -2.0 },
  { x: 6.8, z: 0.0 },
  { x: 6.8, z: 2.0 },
];
const jpTowers = JP_TOWER_POSITIONS.map((pos) => {
  const group = new THREE.Group();
  group.position.set(pos.x, 0, pos.z);
  scene.add(group);
  const coinMeshes = [];
  for (let i = 0; i < JP_TOWER_MAX_COINS; i++) {
    const m = new THREE.Mesh(coinGeo, i % 2 === 0 ? coinMatGold : coinMatSilver);
    const jitter = 0.07;
    m.position.set(
      (Math.random() - 0.5) * jitter,
      i * (COIN_HEIGHT * 0.92) + COIN_HEIGHT / 2,
      (Math.random() - 0.5) * jitter
    );
    m.rotation.y = Math.random() * Math.PI * 2;
    m.castShadow = true;
    m.visible = false;
    group.add(m);
    coinMeshes.push(m);
  }
  return { group, coinMeshes };
});

function updateJpTowerVisual() {
  const frac = Math.min(jpTowerStage, JP_TOWER_MAX_STAGE) / JP_TOWER_MAX_STAGE;
  const visibleCount = Math.round(frac * JP_TOWER_MAX_COINS);
  for (const tw of jpTowers) {
    tw.coinMeshes.forEach((m, i) => { m.visible = i < visibleCount; });
  }
}
updateJpTowerVisual();

// 崩壊演出用のきらめきパーティクル（既存の宝石グリントと同じglintTextureを流用。
// glintTextureはこの位置より下で定義されるが、参照は演出発火時＝ゲーム開始後なので問題ない）
const jpBurstParticles = [];
const JP_BURST_COUNT_PER_TOWER = 14;
const jpFlashEl = document.getElementById('jpFlashOverlay');

function triggerJpTowerCollapse() {
  for (const tw of jpTowers) {
    const visibleCount = tw.coinMeshes.filter((m) => m.visible).length;
    const topY = Math.max(0.6, visibleCount * COIN_HEIGHT * 0.92);
    for (let i = 0; i < JP_BURST_COUNT_PER_TOWER; i++) {
      const mat = new THREE.SpriteMaterial({
        map: glintTexture, color: 0xffe27a, transparent: true, opacity: 1, depthWrite: false,
      });
      const spr = new THREE.Sprite(mat);
      spr.scale.setScalar(0.5 + Math.random() * 0.7);
      spr.position.set(tw.group.position.x, topY, tw.group.position.z);
      scene.add(spr);
      jpBurstParticles.push({
        sprite: spr,
        vel: new THREE.Vector3((Math.random() - 0.5) * 5.5, 2.2 + Math.random() * 4, (Math.random() - 0.5) * 5.5),
        life: 0,
        maxLife: 0.7 + Math.random() * 0.5,
      });
    }
    // タワー本体は即座に空へ（「なだれ込む」見た目はパーティクルで表現し、実際の報酬コインは
    // 既存のspawnCoin()経由で別途投下する＝物理演算コストを増やさないための分離設計）
    tw.coinMeshes.forEach((m) => { m.visible = false; });
  }
  // フラッシュ＋画面シェイク（過去最高に派手に、とのテツさま要望を受けて追加）
  jpFlashEl.classList.remove('flash'); void jpFlashEl.offsetWidth; jpFlashEl.classList.add('flash');
  renderer.domElement.classList.remove('jp-shake'); void renderer.domElement.offsetWidth; renderer.domElement.classList.add('jp-shake');
}

const coins = []; // { mesh, body }
// GETしたコインを画面手前に落とす演出用（物理ワールドには参加させず、簡易な放物運動のみで動かす）
const fallingCoins = []; // { mesh, vx, vy, vz, spinX, spinZ }

// ---------- ボール投入（実機のコインゲームにある「特殊アイテム」の再現） ----------
// コインより一回り大きい球。cannon-esのSphere形状は多角形近似ではなく真円なので、
// コインのような「倒れ防止の回転制限」は不要でそのまま自然に転がる。山の中を
// 転がってコインを押しのけるカオス要素として機能する。得点（GET枚数）にはならない。
const BALL_RADIUS = 0.45;
const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 24, 16);
const ballMat = new THREE.MeshStandardMaterial({ color: 0xe8432f, metalness: 0.55, roughness: 0.2 });
const balls = []; // { mesh, body }

function spawnBall() {
  const mesh = new THREE.Mesh(ballGeo, ballMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // 摩擦・反発係数はコイン用の設定（matCoinの組み合わせ）をそのまま流用する。
  // 「もう少し重めに」の要望を受け1.6→2.0に増量。無人テストで質量3.5では坂を登れなく
  // なることが判明済みのため、23度の坂でも登坂成功率が保てる範囲（3/3成功を確認済み）に留めた
  const body = new CANNON.Body({ mass: 2.0, material: matCoin, linearDamping: 0.045, angularDamping: 0.17 });
  body.addShape(new CANNON.Sphere(BALL_RADIUS));
  body.position.set(0, SPAWN_Y + 0.5, SPAWN_Z);
  world.addBody(body);

  balls.push({ mesh, body });
}

// ---------- 誕生石コレクション（12種類×ジャックポットスロット） ----------
// テツさま発案の新機構。ボールと同じ経路（坂を登り切って得点ラインへ到達）でストッパーを
// 開放する特殊アイテムだが、ボールより長く（5秒）開放し、かつ「どの種類が坂を登り切ったか」
// を記録する。12種類すべてが少なくとも一度は登り切ったら、ジャックポットスロットが起動する。
// 【2026-08-13：㊲ 参考画像（宝石　参考\birthstone-list-all-items_square.png）に基づく
// 全面再設計】これまでの配色はtransmission頼みで彩度が失われ「くすんだ丸い塊」に
// 見えていた（親セッションのA4比較シートで確認済み）。参考画像で実際に表示されている
// 発色に直接近づける形で12色を作り直した。ガーネットとルビーは両方赤系だが、
// ガーネット＝深く沈んだワインレッド、ルビー＝明るく鮮やかな赤、と明度・色相を
// ずらして見分けられるようにしている。カットは実在の宝飾文化・参考画像の見た目に
// 合わせて3種類（brilliant=王道の丸型ファセット、step=エメラルドカットの角形段付き、
// cabochon=ターコイズのような滑らかなドーム）を割り当てた
// 【2026-08-13 ㊳】㊲公開後のテツさま個別フィードバックを反映。色相調整・カット変更
// （ガーネットは丸のまま/ルビーは角形にして見分けやすく、アメジストは楕円、
// ターコイズも楕円）に加え、10月はトルマリン→オパールへ差し替え（実在の10月誕生石でもある）。
// shadowColor: 透過時のattenuationColor個別指定（未指定時は本来の色を暗くした値を自動生成）。
// scaleXYZ: ジオメトリ正規化後に適用する非等倍スケール（楕円化）。
// sizeMul: 正規化後の全体スケール（サイズ調整）。iridescent: 虹色フィルターを追加。
// texture: 'opal'指定でオパール用の斑点テクスチャを貼る。
const GEM_TYPES = [
  { name: 'ガーネット（1月）', color: 0xa20f1f, cut: 'brilliant', shadowColor: 0x120404 },
  { name: 'アメジスト（2月）', color: 0x8b3fd4, cut: 'brilliant', scaleXYZ: [0.76, 1, 1.3] },
  { name: 'アクアマリン（3月）', color: 0x4fd6e0, cut: 'brilliant' },
  { name: 'ダイヤモンド（4月）', color: 0xf3f6fa, cut: 'brilliant', iridescent: true, rainbowFacets: true, iorOverride: 2.4, transmissionOverride: 0.42 },
  // 【2026-08-20 テツさま指摘】旧`emeraldcut`（角丸長方形のブロック）は「全然だめ」との
  // 判定を受け撤去。テツさま提供の参考写真（デザイン関係/宝石　参考/AdobeStock_397965694）＝
  // オーバル/クッションのラウンドブリリアントカット（中央に「ボウタイ」状の明るいハイライトが
  // 出る、放射状の三角ファセット）を踏まえ、既存の`brilliant`（LatheGeometry・24分割の
  // 放射ファセット）をオーバルにscaleXYZで引き伸ばす方式に変更した。アメジストで既に
  // 実績のある手法（丸型ブリリアントをそのまま楕円化）を流用している。
  // 【追加修正】初版のscaleXYZ [0.82,1,1.25]（横に伸ばすだけでY未変更）は、宝石が物理で
  // 自由に転がって様々な角度から見えることを考慮しておらず、真上以外の角度（特に横から
  // の見下ろし）だと「平たい円盤を横から見た薄い刃物のような形」に見えてしまっていた
  // （テツさま報告「円柱型を削ったような形で上下が対象になっている」）。Yも1.4倍に
  // 引き上げて高さ（クラウン〜パビリオンの厚み）を確保し、水平方向の引き伸ばしは
  // 控えめにすることで、どの角度から見ても立体的な宝石に見えるようにした。
  { name: 'エメラルド（5月）', color: 0x0f9d58, cut: 'brilliant', scaleXYZ: [0.88, 1.4, 1.08] },
  { name: 'アレキサンドライト（6月）', color: 0xffffff, cut: 'brilliant', sizeMul: 0.85, gradientTop: 0x1fb066, gradientBottom: 0xa8123f, shadowColor: 0x3a1030 },
  { name: 'ルビー（7月）', color: 0xe31937, cut: 'brilliant', scaleXYZ: [0.88, 1.4, 1.08] },
  { name: 'ペリドット（8月）', color: 0xb8e023, cut: 'brilliant' },
  { name: 'サファイア（9月）', color: 0x0a56f2, cut: 'brilliant' },
  { name: 'オパール（10月）', color: 0xffffff, cut: 'cabochon', scaleXYZ: [0.85, 1, 1.18], sizeMul: 0.75, texture: 'opal', transmissionOverride: 0.05 },
  { name: 'トパーズ（11月）', color: 0xf2a71b, cut: 'brilliant' },
  { name: 'ターコイズ（12月）', color: 0x1fb8ae, cut: 'cabochon', scaleXYZ: [0.86, 1, 1.22], sizeMul: 0.6 },
];

// 「縁石にぶつかる小石」状態だった1/4サイズ（0.11）から拡大。坂の縁の厚み
// （RAMP_THICKNESS=0.07）に対する相対サイズを、ボール（半径比0.156）に近づけることで
// 実際に登り切れるようにするのが狙い（詳細はspec.md参照）。
const GEM_RADIUS = BALL_RADIUS * 0.62;
// 【追加調整】「まだ転がりすぎる」というテツさま報告への対応で2.6→3.2へ増量。
// あわせて後述のangularDampingも引き上げる（㊿の検証で判明した「球体は摩擦だけでは
// 転がり出すと逆に抵抗が下がる」問題に対し、回転そのものを削るdampingの方が効くため）
const GEM_MASS = 3.2;
// 【2026-08-20】転がり速度の絶対上限（ガバナー）。angularは v=ωr を保つ値にして、
// 上限到達時も「滑って」いるようには見えず、自然に転がりが頭打ちになるようにする。
// 【追加修正】初版は落下中も含め常時この上限をかけていたため、「落ちるときの速さを
// 元に戻して」との指摘を受けた（スポーン地点からテーブルへ落ちる自由落下まで遅くなって
// しまっていた）。着地後（＝一度でも何かに接触した後）にのみ適用するよう変更し、
// あわせて「着地後はもっと動きを重くして良い」との指示で上限自体も1.6→1.0へ引き下げた。
const GEM_MAX_SPEED = 1.0;
const GEM_MAX_ANGULAR_SPEED = GEM_MAX_SPEED / GEM_RADIUS;

// 【2026-08-13】低ポリのファセット＋反射だけだと静止時に地味なため、時々明るく
// 煌めく「グリント」スプライトを追加する（カジュアルゲームの宝石アイテムの定番演出）。
// 常にカメラを向くSpriteに、十字型の光跡をCanvasで焼いたテクスチャを貼り、
// 加算合成でランダムな間隔・タイミングでフェードイン→フェードアウトさせる。
function createGlintTexture() {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  const cx = S / 2, cy = S / 2;
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.14);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, S, S);
  // 十字の光条
  const drawRay = (w, len) => {
    const g = ctx.createLinearGradient(cx - len, cy, cx + len, cy);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - len, cy - w / 2, len * 2, w);
  };
  drawRay(3, S * 0.48);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 2);
  ctx.translate(-cx, -cy);
  drawRay(3, S * 0.48);
  ctx.restore();
  return new THREE.CanvasTexture(canvas);
}
const glintTexture = createGlintTexture();
// 【2026-08-20 追加】この速度（線速度＋角速度×半径の概算面速度）を超えたら「動いている」
// とみなし、グリントを派手目にする。要実機確認（他の物理チューニングと同様に微調整の余地あり）。
const GLINT_MOTION_SPEED_THRESHOLD = 0.4;

// 【2026-08-13：㊲ 参考画像に基づく再設計】㉟で採用したCC0完成品モデル（意図的に
// ローポリ・8〜16面程度）では、参考画像のような「放射状の細かいファセットで輝く」
// 質感を再現できないと判断し、プロシージャルなジオメトリへ戻した（過去のWeb検索でも
// 面数の多い実写系フリーモデルの決め手を欠いたため、面数を確実にコントロールできる
// 自前生成を選択）。LatheGeometryの回転分割数を24に増やし、本物のラウンドブリリアント
// カット（クラウン+ガードル+パビリオン）に近い断面にすることで、facet数を大幅に増やした
// （旧モデル比で6倍以上）。flatShading:trueと組み合わせることで面ごとに明暗が変わり、
// 参考画像に近い「キラキラ」を狙う。
function makeBrilliantGeometry(r) {
  const pts = [
    new THREE.Vector2(0, r * 0.36),
    new THREE.Vector2(r * 0.42, r * 0.34),
    new THREE.Vector2(r * 0.64, r * 0.24),
    new THREE.Vector2(r * 0.84, r * 0.09),
    new THREE.Vector2(r * 1.0, 0),
    new THREE.Vector2(r * 0.56, -r * 0.42),
    new THREE.Vector2(0, -r * 0.8),
  ];
  const geo = new THREE.LatheGeometry(pts, 24);
  geo.computeVertexNormals();
  geo.center();
  return geo;
}
// カボションカット：ターコイズのような、ファセットのない滑らかなドーム状の輝き
// （参考画像でも他の石よりマットで丸みのある質感になっている）
function makeCabochonGeometry(r) {
  const geo = new THREE.SphereGeometry(r, 20, 14);
  geo.computeVertexNormals();
  return geo;
}
// 【2026-08-20】旧`makeEmeraldCutGeometry`（角丸長方形ブロックにExtrudeGeometryの
// bevelを効かせたもの）は、bevel強化後もテツさま実機評価「全然だめ」だったため廃止。
// ルビー・エメラルドとも`makeBrilliantGeometry`＋scaleXYZのオーバル化に統一したため、
// この関数はどのGEM_TYPESからも参照されなくなった（詳細はGEM_TYPES側のコメント参照）。
const GEM_CUT_FACTORIES = { brilliant: makeBrilliantGeometry, cabochon: makeCabochonGeometry };
// プロシージャル生成なので同期的に即座に全て揃う（旧GLTFLoaderのような非同期ロード待ちは不要）。
// 生成後にbounding sphereを基準にGEM_RADIUSへ正規化し、カットによらず当たり判定
// （CANNON.Sphere(GEM_RADIUS)）とだいたい同じ大きさに揃える。その後、個別指定があれば
// scaleXYZ（楕円化）・sizeMul（全体サイズ調整）を適用する。flatShading:trueのマテリアルは
// フラグメントシェーダ側で面法線を導出するため、非等倍スケール後に法線を再計算する必要はない。
// 頂点カラーによるグラデーション焼き込み（アレキサンドライトの「緑→ワインレッド」用）。
// Y座標（上下）に沿って2色を線形補間し、`color`属性として焼き込む。マテリア側で
// vertexColors:trueにするとベース色に乗算されるため、gの`color`は白(0xffffff)にして
// グラデーションの色みを純粋に反映させる。
function applyGradientVertexColors(geo, colorTop, colorBottom) {
  const pos = geo.attributes.position;
  geo.computeBoundingBox();
  const minY = geo.boundingBox.min.y;
  const span = Math.max(geo.boundingBox.max.y - minY, 1e-6);
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(colorTop), bottom = new THREE.Color(colorBottom), tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - minY) / span;
    tmp.copy(bottom).lerp(top, t);
    colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
// ダイヤモンド用「虹色の反射」。物理ベースの`iridescence`プロパティだけでは、平らな
// ファセット1面ごとに単一の反射色しか乗らず、静止画・単一視点ではほとんど無色に近く
// 見えてしまう（テツさま指摘「ただのガラス」）ことが分かったため、iridescenceは
// 残しつつ、確実に見える保険として頂点カラーでも虹色を焼き込む。ラウンドブリリアント
// （LatheGeometry, 円周方向に24分割）はY軸まわりの角度がそのままファセットの境界と
// 一致するため、角度→色相（フルスペクトラム）でマッピングすると、ファセットの区切り
// にきれいに沿った「虹色のリング」になる。
// 【2026-08-13：㊸】初版（彩度0.55/明度0.82）は「色鮮やかさが失われた」とのフィード
// バックを受け、彩度・濃さを上げた（彩度0.55→0.8、明度0.82→0.62）。あわせて
// GEM_TYPES側のtransmissionOverrideも0.3→0.42（他の宝石と同水準）に戻し、
// 透明感も両立させる。
function applyRainbowFacetTint(geo) {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const angle = Math.atan2(pos.getZ(i), pos.getX(i));
    const hue = (angle / (Math.PI * 2) + 1) % 1;
    tmp.setHSL(hue, 0.8, 0.62);
    colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
const gemGeos = GEM_TYPES.map((g) => {
  const geo = GEM_CUT_FACTORIES[g.cut](GEM_RADIUS);
  geo.computeBoundingSphere();
  const scale = GEM_RADIUS / geo.boundingSphere.radius;
  geo.scale(scale, scale, scale);
  geo.center();
  if (g.scaleXYZ) {
    geo.scale(g.scaleXYZ[0], g.scaleXYZ[1], g.scaleXYZ[2]);
    geo.center();
  }
  if (g.sizeMul) {
    geo.scale(g.sizeMul, g.sizeMul, g.sizeMul);
  }
  if (g.gradientTop !== undefined) {
    applyGradientVertexColors(geo, g.gradientTop, g.gradientBottom);
  }
  if (g.rainbowFacets) {
    applyRainbowFacetTint(geo);
  }
  return geo;
});

// 【2026-08-13：㊹ テツさま指摘】プロシージャル生成の斑点テクスチャ（㊶時点）が
// 「ただのお饅頭」に見えると再度の指摘があり、「画像をそのまま貼り付けたりした方が
// 良いかも」との提案を受けて方針転換。実物オパールの参考写真（デザイン関係/宝石　参考/
// birthstone-list-all-items_square.pngの10月オパール部分を切り出したもの）を実際に
// タイル状に敷き詰めて焼き込む。カボション（SphereGeometry）は既定のUVで全周を覆うため、
// 写真1枚をそのまま単純マッピングすると極（上下）でピンチして歪む。4×4のタイルに分割し、
// タイルごとに反転・回転を変えて敷き詰めることで、継ぎ目が目立たないようにしている。
const OPAL_PHOTO_DATA_URI = "data:image/jpeg;base64,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";
let opalPhotoImg = null;
function createOpalTexture() {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  // 4×4タイリングは継ぎ目（隙間）が変に見えるとの指摘を受け、表裏2箇所（球のUVを
  // 経度方向に2分割し、それぞれに写真を1枚ずつ大きく貼る＝コインの表裏のような構成）
  // へ縮小。写真は角丸のない矩形のままだと隅にわずかに木製の背景が写り込んでいるため、
  // 楕円クリップで石の輪郭だけを切り抜いて貼る。クリップの外側（縫い目付近）は写真の
  // 乳白色に近い下地色で塗っておき、境界が唐突に見えないようにしている。
  ctx.fillStyle = '#ded6c4';
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(canvas);

  const drawFaces = (img) => {
    const halfW = S / 2;
    // 【2026-08-13：㊼ テツさま指摘「淵の茶色部分を消して、もう少しだけ色を濃い目に」】
    // 従来は写真を縦長の枠（halfW×S＝1:2）へ縦横比を無視して引き伸ばして貼っていたため、
    // 写真の実際の縦横比（約4:5）とズレ、四隅にわずかに写り込む木製の背景（撮影台）が
    // クリップ境界の近くまで来てしまい「茶色い縁」として見えていた。写真本来の縦横比を
    // 保ったまま矩形内に収める（contain）方式に変更し、実際に描画される写真の大きさに
    // 合わせて少し内側に絞ったクリップ楕円を使うことで、背景の写り込みを確実に除去する。
    // あわせてCanvas 2Dのfilterで彩度を上げ、色をもう少し濃く鮮やかにした。
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const scale = Math.min(halfW / iw, S / ih);
    const dw = iw * scale, dh = ih * scale;
    const drawFace = (offsetX, mirror) => {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(offsetX + halfW / 2, S / 2, dw / 2 * 0.92, dh / 2 * 0.92, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(offsetX + halfW / 2, 0);
      ctx.scale(mirror ? -1 : 1, 1);
      ctx.filter = 'saturate(145%) brightness(0.97)';
      ctx.drawImage(img, -dw / 2, (S - dh) / 2, dw, dh);
      ctx.filter = 'none';
      ctx.restore();
    };
    drawFace(0, false); // 表
    drawFace(halfW, true); // 裏（鏡映して表との境界を馴染ませる）
    tex.needsUpdate = true;
  };

  if (opalPhotoImg) {
    drawFaces(opalPhotoImg);
  } else {
    const img = new Image();
    img.onload = () => { opalPhotoImg = img; drawFaces(img); };
    img.src = OPAL_PHOTO_DATA_URI;
  }

  return tex;
}

// マテリアル：㊲で確立した「彩度の高い発色＋ファセットの反射・きらめき」の土台を
// 崩さないまま、㊳でtransmission（透過）を段階的に足し戻した（テツさま要望：
// 「透明度を上げつつ、手前は薄く・奥は濃く見える階調をつけてほしい」）。
// ㊱の反省（transmission0.9+暗すぎるattenuationColorで色が濁った）を踏まえ、
// 今回はtransmissionを0.42程度に留め、attenuationColorは各宝石本来の鮮やかな色を
// 基本にする（HSLで明度を42%程度に落とした「濃縮版」の色）ことで、「宝石ごとの色が
// はっきり区別できる」を最優先ラインとして維持しつつ、手前(薄)→奥(濃)の階調を出す。
// ガーネットだけはテツさま指定で奥側をほぼ黒に。
const GEM_TRANSMISSION = 0.42;
const gemMats = GEM_TYPES.map((g) => {
  const baseColor = new THREE.Color(g.color);
  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);
  const defaultShadow = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.08), Math.max(0.06, hsl.l * 0.42));
  const shadowColor = g.shadowColor !== undefined ? new THREE.Color(g.shadowColor) : defaultShadow;
  const transmission = g.transmissionOverride !== undefined ? g.transmissionOverride : (g.cut === 'cabochon' ? 0.1 : GEM_TRANSMISSION);
  const m = new THREE.MeshPhysicalMaterial({
    color: g.color,
    metalness: 0.04,
    roughness: 0.045,
    flatShading: true,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    transmission,
    ior: g.iorOverride !== undefined ? g.iorOverride : 1.9,
    attenuationColor: shadowColor,
    attenuationDistance: GEM_RADIUS * 0.85,
  });
  if (g.iridescent) {
    // ダイヤモンド専用：テツさま指摘「ただのガラス、虹色っぽい反射にできないか」を受けて
    // 強化（旧:iridescence0.4/IOR1.3/thickness100-400では効果が弱く視認しづらかった）。
    // iridescenceを最大近くまで上げ、厚み範囲も広げて色の出方に幅を持たせた。
    // あわせてior・transmissionもGEM_TYPES側でダイヤモンド専用に上書き（本物のダイヤに
    // 近い高屈折率にしつつ、transmissionをやや抑えて反射面の虹色が埋もれないようにした）
    m.iridescence = 1.0;
    m.iridescenceIOR = 1.9;
    m.iridescenceThicknessRange = [200, 900];
  }
  if (g.texture === 'opal') {
    // テツさま指摘「ただのお饅頭、もっと多層的に虹色っぽさを出して」を受けて、テクスチャ
    // 自体を3層構造に刷新（createOpalTexture参照）した上で、表面の艶も少し戻して
    // マットになりすぎないようにした（旧:roughness0.14/clearcoat0.75）
    m.map = createOpalTexture();
    m.roughness = 0.1;
    m.clearcoat = 0.9;
  }
  if (g.gradientTop !== undefined || g.rainbowFacets) {
    // アレキサンドライト（頂点カラーで緑→ワインレッド）・ダイヤモンド（頂点カラーで
    // 虹色のファセット染め）はどちらも頂点カラーでベース色を表現するため、マテリアルの
    // colorは白のまま乗算し、頂点カラーの色みをそのまま反映させる
    m.vertexColors = true;
  }
  m.envMap = gemEnvTexture;
  m.envMapIntensity = 3.4;
  return m;
});
const gems = []; // { mesh, body, typeIndex }
const collectedGems = new Set();

function spawnGem() {
  // gemGeosはプロシージャル生成で同期的に全て揃っているため、単純にランダムに選ぶ
  const typeIndex = Math.floor(Math.random() * GEM_TYPES.length);
  const mesh = new THREE.Mesh(gemGeos[typeIndex], gemMats[typeIndex]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // グリント（きらめき）スプライトをGLINT_POOL_SIZE個添える。テツさま指示（2026-08-13）
  // で「1回の発光イベントで2〜3箇所が同時にランダムな位置で光る」「サイズも1/2〜1/4程度に
  // 小さくランダムに」に変更。プールから毎回2〜3個をランダムに選び、宝石表面付近の
  // ランダムなローカル座標・ランダムなサイズを割り当てて同時にフェードイン→フェードアウトする
  // （updateGemGlintsで駆動）。常にカメラ向き・加算合成。
  const GLINT_POOL_SIZE = 3;
  const glintSprites = [];
  for (let k = 0; k < GLINT_POOL_SIZE; k++) {
    const glintMat = new THREE.SpriteMaterial({
      map: glintTexture, color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glint = new THREE.Sprite(glintMat);
    glint.scale.setScalar(GEM_RADIUS * 2.6 * 0.18); // 追加調整：もっと小さく
    scene.add(glint);
    glintSprites.push(glint);
  }
  const glintState = {
    sprites: glintSprites,
    offsets: glintSprites.map(() => new THREE.Vector3()),
    nextAt: clock.elapsedTime + Math.random() * 1.2, // 追加調整：初回もより早く光り出す
    burstActive: false,
    moving: false,
  };

  // 【2026-08-12再調整】allowSleep:falseで永久凍結バグ（㉚）は解消したが、副作用として
  // 「二度と静止できず転がり続ける」状態になっていた（テツさま報告「すごいころがって
  // しまう」）。allowSleepをtrueに戻しつつ、既定（sleepSpeedLimit:0.1 / sleepTimeLimit:1）
  // より大幅に緩い閾値にすることで、「一瞬の減速では眠らない（＝坂に届く前の早すぎる
  // スリープを防ぐ）」と「本当に静止したら眠る（＝転がり続けない）」を両立させる
  // 【㊿】linearDampingを0.08→0.16へ引き上げ。摩擦だけだと「転がり始めた後」の
  // 抵抗として効きにくい（球体が滑りから転がりへ転じると抵抗が下がるため）ので、
  // 常に速度を削るdampingを併用し、着地直後の急な滑り出しを穏やかにする
  // 【追加調整】それでも「まだ転がりすぎる」との報告を受け、linearDampingを0.16→0.22、
  // angularDampingを0.28→0.45へさらに引き上げ（回転を削ることで「滑り」への逆戻りを
  // 防ぎつつ、転がり自体の勢いも早めに落ち着かせる狙い）
  const body = new CANNON.Body({
    mass: GEM_MASS, material: matGem, linearDamping: 0.22, angularDamping: 0.45,
    allowSleep: true, sleepSpeedLimit: 0.02, sleepTimeLimit: 2.0,
  });
  body.addShape(new CANNON.Sphere(GEM_RADIUS));
  body.position.set(0, SPAWN_Y + 0.5, SPAWN_Z);
  world.addBody(body);

  // 【2026-08-20】「落ちるときの速さは元に戻して、着地後はもっと重くしていい」との指示で、
  // GEM_MAX_SPEEDによる速度上限は着地後にのみ適用する。最初の衝突（＝テーブルや坂に
  // 触れた瞬間）をcollideイベントで検知し、以降landed=trueとしてメインループ側で参照する。
  const gemEntry = { mesh, body, typeIndex, glint: glintState, landed: false };
  body.addEventListener('collide', () => { gemEntry.landed = true; });
  gems.push(gemEntry);
}

const gemCountEl = document.getElementById('gemCount');
const gemDotsEl = document.getElementById('gemDots');
const gemDotEls = GEM_TYPES.map((g) => {
  const dot = document.createElement('div');
  dot.className = 'dot';
  const hex = `#${g.color.toString(16).padStart(6, '0')}`;
  dot.style.background = hex;
  dot.style.color = hex; // .dot.collectedのbox-shadow(currentColor)に使う
  dot.title = g.name;
  gemDotsEl.appendChild(dot);
  return dot;
});
function updateGemTrackerUI() {
  gemCountEl.textContent = `誕生石: ${collectedGems.size} / ${GEM_TYPES.length}`;
  gemDotEls.forEach((el, i) => el.classList.toggle('collected', collectedGems.has(i)));
}
updateGemTrackerUI();

let holeCount = 0;

// ---------- ポーカー（(54)カジノゲーム化、Step7） ----------
// アーチ穴（Step6）に10枚溜まったら発動。ドローポーカー（カードチェンジ最大2回、
// レイズ無し）、プレイヤー対ディーラーの対戦形式。役判定は mdp/hoyle
// （https://github.com/mdp/hoyle, MITライセンス）の考え方を参考にJSへ移植。
const CARD_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const CARD_SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
const HAND_NAME_JA = {
  highCard: 'ハイカード', onePair: 'ワンペア', twoPair: 'ツーペア', threeOfAKind: 'スリーカード',
  straight: 'ストレート', flush: 'フラッシュ', fullHouse: 'フルハウス', fourOfAKind: 'フォーカード',
  straightFlush: 'ストレートフラッシュ', royalFlush: 'ロイヤルストレートフラッシュ',
};

function makeDeck() {
  const deck = [];
  for (const s of CARD_SUITS) for (const r of CARD_RANKS) deck.push({ rank: r, suit: s });
  deck.push({ rank: 'JOKER', suit: null });
  return deck;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ジョーカーはドローポーカーの手札としては配らない設計（配当ルールにジョーカーの
// 扱いが含まれていないため）。デッキには含めるが、配布時にリドローで除外する。
function evaluateHand(cards) {
  const ranks = cards.map(c => RANK_VALUES[c.rank]).sort((a, b) => a - b);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  const rankCounts = {};
  for (const r of ranks) rankCounts[r] = (rankCounts[r] || 0) + 1;
  const countEntries = Object.entries(rankCounts).map(([r, c]) => [Number(r), c]);
  countEntries.sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const counts = countEntries.map(e => e[1]);
  const kickers = countEntries.map(e => e[0]);

  const uniqueRanks = [...new Set(ranks)];
  let isStraight = false;
  let straightHigh = ranks[4];
  if (uniqueRanks.length === 5) {
    if (ranks[4] - ranks[0] === 4) {
      isStraight = true;
    } else if (ranks[0] === 2 && ranks[1] === 3 && ranks[2] === 4 && ranks[3] === 5 && ranks[4] === 14) {
      isStraight = true; // A-2-3-4-5のホイール（Aを1として扱う）
      straightHigh = 5;
    }
  }

  const isRoyalSpadeFlush = isStraight && isFlush && straightHigh === 14 && cards.every(c => c.suit === 'spades');

  if (isRoyalSpadeFlush) return { rank: 9, name: 'royalFlush', kickers: [straightHigh] };
  if (isStraight && isFlush) return { rank: 8, name: 'straightFlush', kickers: [straightHigh] };
  if (counts[0] === 4) return { rank: 7, name: 'fourOfAKind', kickers };
  if (counts[0] === 3 && counts[1] === 2) return { rank: 6, name: 'fullHouse', kickers };
  if (isFlush) return { rank: 5, name: 'flush', kickers: [...ranks].sort((a, b) => b - a) };
  if (isStraight) return { rank: 4, name: 'straight', kickers: [straightHigh] };
  if (counts[0] === 3) return { rank: 3, name: 'threeOfAKind', kickers };
  if (counts[0] === 2 && counts[1] === 2) return { rank: 2, name: 'twoPair', kickers };
  if (counts[0] === 2) return { rank: 1, name: 'onePair', kickers };
  return { rank: 0, name: 'highCard', kickers: [...ranks].sort((a, b) => b - a) };
}
// 正: handAの勝ち／負: handBの勝ち／0: 引き分け
function compareHands(handA, handB) {
  if (handA.rank !== handB.rank) return handA.rank - handB.rank;
  const len = Math.max(handA.kickers.length, handB.kickers.length);
  for (let i = 0; i < len; i++) {
    const a = handA.kickers[i] ?? 0;
    const b = handB.kickers[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

// ディーラーAI（カードチェンジ判断）：標準的なビデオポーカー戦略の簡易版。
// 役の構成要素（ペア以上）はキープし、それ以外を交換する。役がなければ最高
// ランク1枚だけ残して残り4枚を交換する単純化した戦略（実装判断、実証後に調整可）。
function decideDealerDiscards(cards) {
  const ranks = cards.map(c => RANK_VALUES[c.rank]);
  const rankCounts = {};
  ranks.forEach(r => { rankCounts[r] = (rankCounts[r] || 0) + 1; });
  const pairedRanks = Object.entries(rankCounts).filter(([, c]) => c >= 2).map(([r]) => Number(r));
  if (pairedRanks.length > 0) {
    // ペア以上の役を構成するカードは残し、それ以外を交換
    return cards.map((c, i) => !pairedRanks.includes(ranks[i]));
  }
  // 役なし：最高ランク1枚のみキープ
  const maxRank = Math.max(...ranks);
  let kept = false;
  return cards.map((c, i) => {
    if (!kept && ranks[i] === maxRank) { kept = true; return false; }
    return true;
  });
}

// ---------- ポーカーのカード見た目（3Dメッシュ・テクスチャ） ----------
// カードアセット：デザイン関係/ポーカー　参考/_生成カード/新しいフォルダー/ を
// tools/optimize_cards.py で512px幅・JPEG化して軽量化したもの（assets/cards/）。
// 通常画像は各カードの絵柄、_metal.pngは金線部分のみ白いmetalnessMap用マスク
// （ハート/ダイヤ=金、スペード/クラブ=銀の反射をThree.js実装時に付ける）。
const CARD_TEX_LOADER = new THREE.TextureLoader();
const CARD_TEX_CACHE = new Map(); // key -> { map, metalMap }
function cardAssetName(card) {
  return card.rank === 'JOKER' ? 'Joker' : `${card.rank}_of_${card.suit}`;
}
function loadCardTexture(name) {
  if (CARD_TEX_CACHE.has(name)) return CARD_TEX_CACHE.get(name);
  const map = CARD_TEX_LOADER.load(`assets/cards/${name}.jpg`);
  map.colorSpace = THREE.SRGBColorSpace;
  const metalMap = CARD_TEX_LOADER.load(`assets/cards/${name}_metal.png`);
  const entry = { map, metalMap };
  CARD_TEX_CACHE.set(name, entry);
  return entry;
}
// ポーカー発動前にゲーム起動時から静かにプリロードしておく（52枚+ジョーカー、3.5MB程度）
for (const s of CARD_SUITS) for (const r of CARD_RANKS) loadCardTexture(`${r}_of_${s}`);
loadCardTexture('Joker');

const CARD_W = 1.15;
const CARD_H = CARD_W * (1260 / 900); // 元画像の縦横比(900x1260)に合わせる
const CARD_THICKNESS = 0.012;
const cardBackMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.5, metalness: 0.15 });
const cardEdgeMat = new THREE.MeshStandardMaterial({ color: 0x1a1408, roughness: 0.6, metalness: 0.1 });

// faceUp=false: 裏向き（テツさま指示＝専用背面デザインは作らずフラットな黒）
// faceUp=true: 表向き（カード種別に応じたテクスチャ＋metalnessMap）
function createCardMesh(card, faceUp) {
  const geo = new THREE.BoxGeometry(CARD_W, CARD_H, CARD_THICKNESS);
  let frontMat;
  if (faceUp) {
    const tex = loadCardTexture(cardAssetName(card));
    frontMat = new THREE.MeshStandardMaterial({
      map: tex.map, metalnessMap: tex.metalMap, metalness: 1.0, roughness: 0.35,
    });
  } else {
    frontMat = cardBackMat;
  }
  // 選択中のハイライト表現用に縁のマテリアルはカードごとに複製する（共有だと全カードに影響するため）
  const edgeMat = cardEdgeMat.clone();
  // BoxGeometryの面順は [+x,-x,+y,-y,+z,-z]。+zを正面（表）として扱う。
  const mats = [edgeMat, edgeMat, edgeMat, edgeMat, frontMat, cardBackMat];
  const mesh = new THREE.Mesh(geo, mats);
  mesh.castShadow = true;
  mesh.userData.edgeMat = edgeMat;
  return mesh;
}
function setCardSelectedVisual(mesh, selected) {
  mesh.userData.edgeMat.emissive.setHex(selected ? 0xffcc33 : 0x000000);
  mesh.userData.edgeMat.emissiveIntensity = selected ? 1.4 : 1.0;
}

// ---------- ポーカー進行管理（(54)Step7） ----------
// アーチ穴（Step6）に10枚溜まったら発動。登場演出＝プッシャー奥の壁に急に1枚ずつ並ぶ。
// プレイヤーは手札をマウスで選択→カードチェンジ（最大2回）→勝負する、の流れ。
// ディーラーは人物を出さずカードのみで表現し、標準的なビデオポーカー戦略でチェンジする。
const pokerCardGroup = new THREE.Group();
scene.add(pokerCardGroup);

// 【正直な記録・実機フィードバック2026-08-26で修正】初版はCARD_W=0.62・Y=1.35/2.05・
// 壁の中央配置で実装したが、①スクリーンショットでコインの山と壁際に埋もれてほとんど
// 視認できないことが判明（JPタワー(Step3)で得た「壁の内側・小さいサイズは既定カメラ
// から見えにくい」教訓と同じ問題）→カードサイズを約2倍に拡大、②そもそも
// counseling_log.mdのコアループでは「画面左側に登場演出」と決まっていたのに、実装時に
// 壁の中央（左右対称）に配置してしまっていた（実装ミス）→X_OFFSETで画面左寄りに変更。
const POKER_CARD_SPACING = 1.3;
const POKER_CARD_X_OFFSET = -3.0; // 画面左側に寄せる（元は0=中央だった）
const POKER_PLAYER_Y = 1.85;
const POKER_DEALER_Y = 2.85;
const POKER_CARD_Z = WALL_Z_BACK + 0.42;
const POKER_DEALER_CARD_Z = WALL_Z_BACK + 0.26;
const POKER_DEAL_INTERVAL = 0.12;   // カードが1枚ずつ出現する間隔
const POKER_DEAL_ANIM_DURATION = 0.25;
const POKER_SELECT_LIFT = 0.18;     // 選択中カードの持ち上げ量
const POKER_DEALER_THINK_DURATION = 0.9;
const POKER_SHOWDOWN_REVEAL_DURATION = 1.1;
const POKER_RESULT_HOLD_DURATION = 3.0;
const POKER_CLEAR_DURATION = 1.0;

function pokerCardX(i) { return POKER_CARD_X_OFFSET + (i - 2) * POKER_CARD_SPACING; }

// 【実機フィードバック2026-08-26】既存ライト（sun/spot/accentLight）はプレイフィールド
// 中央〜手前を照らす配置のため、壁際の高い位置にあるカードまで光が十分届かず、
// metalnessMapによる金属反射が活きていなかった。カードの手前上方から専用に照らす
// ライトを追加（カジノのスポットライト演出も兼ねる）。
const pokerCardLight = new THREE.PointLight(0xfff2d0, 1.8, 9);
pokerCardLight.position.set(POKER_CARD_X_OFFSET, 3.6, -1.0);
scene.add(pokerCardLight);

// 【実機フィードバック2026-08-26】カードの奥が真っ黒のままで寂しいとの指摘。正式な
// デザインは今後別途相談するとして、まずは仮の背景（カジノのカーテン風グラデーション
// ＋縦のひだ模様）を壁のさらに奥に配置しておく。
function createPokerBackdropTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#33101c');
  grad.addColorStop(0.55, '#200a14');
  grad.addColorStop(1, '#0a0508');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 0.12;
  for (let x = 0; x < canvas.width; x += 22) {
    ctx.fillStyle = (x / 22) % 2 === 0 ? '#000000' : '#ffd76a';
    ctx.fillRect(x, 0, 11, canvas.height);
  }
  ctx.globalAlpha = 1;
  return new THREE.CanvasTexture(canvas);
}
const pokerBackdropMat = new THREE.MeshStandardMaterial({
  map: createPokerBackdropTexture(), roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide,
});
const pokerBackdrop = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 4.2), pokerBackdropMat);
pokerBackdrop.position.set(POKER_CARD_X_OFFSET, 2.5, WALL_Z_BACK - 0.05);
scene.add(pokerBackdrop);

let pokerState = 'idle'; // idle|dealing|playerTurn|dealerTurn|showdown|result|clearing
let pokerAfterDealState = 'playerTurn';
let pokerDeck = [];
let playerHand = []; // { card, mesh, selected }
let dealerHand = []; // { card, mesh }
let pokerDealQueue = []; // 登場/交換アニメーション待ちのメッシュ
let pokerDealTimer = 0;
let pokerDiscardsLeft = 2;
let pokerStateTimer = 0;
let pokerClearParticles = [];

const pokerPanelEl = document.getElementById('pokerPanel');
const pokerHintEl = document.getElementById('pokerHint');
const btnPokerDiscardEl = document.getElementById('btnPokerDiscard');
const btnPokerStandEl = document.getElementById('btnPokerStand');
const pokerResultOverlayEl = document.getElementById('pokerResultOverlay');
const pokerResultTitleEl = document.getElementById('pokerResultTitle');
const pokerResultSubEl = document.getElementById('pokerResultSub');

// 役ごとの配当（仮値。「実証後に検討しよう」とのテツさま方針＝実装して実機で試してから調整）
const HAND_PAYOUT = {
  highCard: 20, onePair: 24, twoPair: 28, threeOfAKind: 34, straight: 40,
  flush: 46, fullHouse: 52, fourOfAKind: 58, straightFlush: 60, royalFlush: 60,
};
const POKER_LOSE_PAYOUT = 5;

function clearPokerCards() {
  for (const h of [...playerHand, ...dealerHand]) pokerCardGroup.remove(h.mesh);
  playerHand = [];
  dealerHand = [];
}

function startPoker() {
  if (pokerState !== 'idle') return;
  clearPokerCards();
  pokerDeck = shuffle(makeDeck().filter(c => c.rank !== 'JOKER')); // ドローポーカーはジョーカー抜き52枚
  pokerDealQueue = [];
  for (let i = 0; i < 5; i++) {
    const card = pokerDeck.pop();
    const mesh = createCardMesh(card, true);
    mesh.position.set(pokerCardX(i), POKER_PLAYER_Y, POKER_CARD_Z);
    mesh.scale.setScalar(0.001);
    pokerCardGroup.add(mesh);
    playerHand.push({ card, mesh, selected: false });
    pokerDealQueue.push(mesh);
  }
  for (let i = 0; i < 5; i++) {
    const card = pokerDeck.pop();
    // 視点移動で裏側が見えないよう、裏向きカードは表面も裏面と同じ黒マテリアルにする
    const mesh = createCardMesh(card, false);
    mesh.position.set(pokerCardX(i), POKER_DEALER_Y, POKER_DEALER_CARD_Z);
    mesh.scale.setScalar(0.001);
    pokerCardGroup.add(mesh);
    dealerHand.push({ card, mesh });
    pokerDealQueue.push(mesh);
  }
  pokerDiscardsLeft = 2;
  pokerAfterDealState = 'playerTurn';
  pokerState = 'dealing';
  pokerDealTimer = 0;
  pokerPanelEl.classList.remove('show');
  pokerResultOverlayEl.classList.remove('show');
}

function refreshPokerHint() {
  const n = playerHand.filter(h => h.selected).length;
  pokerHintEl.textContent = `交換したいカードをクリックして選択中: ${n}枚（残り${pokerDiscardsLeft}回）`;
  btnPokerDiscardEl.disabled = n === 0 || pokerDiscardsLeft <= 0;
}

function onPlayerDiscardClick() {
  if (pokerState !== 'playerTurn' || pokerDiscardsLeft <= 0) return;
  const toReplace = playerHand.filter(h => h.selected);
  if (toReplace.length === 0) return;
  pokerDealQueue = [];
  for (const entry of toReplace) {
    pokerCardGroup.remove(entry.mesh);
    const newCard = pokerDeck.pop();
    const newMesh = createCardMesh(newCard, true);
    const i = playerHand.indexOf(entry);
    newMesh.position.set(pokerCardX(i), POKER_PLAYER_Y, POKER_CARD_Z);
    newMesh.scale.setScalar(0.001);
    pokerCardGroup.add(newMesh);
    entry.card = newCard;
    entry.mesh = newMesh;
    entry.selected = false;
    pokerDealQueue.push(newMesh);
  }
  pokerDiscardsLeft--;
  pokerAfterDealState = 'playerTurn';
  pokerState = 'dealing';
  pokerDealTimer = 0;
  pokerPanelEl.classList.remove('show');
}

function onPlayerStandClick() {
  if (pokerState !== 'playerTurn') return;
  pokerPanelEl.classList.remove('show');
  pokerState = 'dealerTurn';
  pokerStateTimer = 0;
}

btnPokerDiscardEl.addEventListener('click', (e) => { e.stopPropagation(); onPlayerDiscardClick(); });
btnPokerStandEl.addEventListener('click', (e) => { e.stopPropagation(); onPlayerStandClick(); });

// ディーラーのカードチェンジ（標準的なビデオポーカー戦略、decideDealerDiscardsで判断）。
// まだ裏向きのため見た目の変化はなく、演出上は「考えている」間を置くだけでよい。
function resolveDealerTurn() {
  const cards = dealerHand.map(h => h.card);
  const discardFlags = decideDealerDiscards(cards);
  dealerHand.forEach((entry, i) => {
    if (!discardFlags[i]) return;
    const newCard = pokerDeck.pop();
    entry.card = newCard; // 裏向きのままなのでメッシュの張り替えは不要
  });
  pokerState = 'showdown';
  pokerStateTimer = 0;
  // ディーラーの手札を表向きに差し替える（めくる演出のトリガー）
  dealerHand.forEach((entry, i) => {
    pokerCardGroup.remove(entry.mesh);
    const newMesh = createCardMesh(entry.card, true);
    newMesh.position.set(pokerCardX(i), POKER_DEALER_Y, POKER_DEALER_CARD_Z);
    newMesh.scale.setScalar(1);
    pokerCardGroup.add(newMesh);
    entry.mesh = newMesh;
  });
}

function awardGemFromPoker() {
  const uncollected = [];
  for (let i = 0; i < GEM_TYPES.length; i++) if (!collectedGems.has(i)) uncollected.push(i);
  if (uncollected.length === 0) return;
  const typeIndex = uncollected[Math.floor(Math.random() * uncollected.length)];
  collectedGems.add(typeIndex);
  updateGemTrackerUI();
  jpTowerStage = Math.min(jpTowerStage + 1, JP_TOWER_MAX_STAGE);
  updateJpTowerVisual();
  if (collectedGems.size >= GEM_TYPES.length && jackpotState === 'idle') {
    startJackpot();
  }
}

function resolveShowdown() {
  const playerCards = playerHand.map(h => h.card);
  const dealerCards = dealerHand.map(h => h.card);
  const playerResult = evaluateHand(playerCards);
  const dealerResult = evaluateHand(dealerCards);
  // プレイヤー対ディーラーの対戦形式。役がいくら強くても負けたら残念賞（引き分けも負け扱い）
  const win = compareHands(playerResult, dealerResult) > 0;

  let coinReward, gemsAwarded;
  if (win) {
    coinReward = HAND_PAYOUT[playerResult.name];
    // 最高役（スペードのロイヤルストレートフラッシュ）のみ誕生石2個、他の勝ちは1個
    gemsAwarded = playerResult.name === 'royalFlush' ? 2 : 1;
  } else {
    coinReward = POKER_LOSE_PAYOUT;
    gemsAwarded = 0;
  }
  for (let i = 0; i < gemsAwarded; i++) awardGemFromPoker();
  rainQueueCount += coinReward;
  rainTimer = 0;

  pokerResultTitleEl.textContent = win
    ? `WIN！ ${HAND_NAME_JA[playerResult.name]}`
    : `残念… ${HAND_NAME_JA[playerResult.name]} vs ${HAND_NAME_JA[dealerResult.name]}`;
  pokerResultSubEl.textContent = win
    ? `+${coinReward}枚${gemsAwarded > 0 ? `　＋誕生石${gemsAwarded}個` : ''}`
    : `残念賞 +${coinReward}枚`;
  pokerResultOverlayEl.classList.add('show');

  pokerState = 'result';
  pokerStateTimer = 0;
}

// 退場演出：きらっと光って金色のミストとともに消える（勝敗にかかわらず同じ演出）
function startPokerClearing() {
  pokerState = 'clearing';
  pokerStateTimer = 0;
  pokerResultOverlayEl.classList.remove('show');
  pokerClearParticles = [];
  for (const h of [...playerHand, ...dealerHand]) {
    for (let k = 0; k < 4; k++) {
      const mat = new THREE.SpriteMaterial({
        map: glintTexture, color: 0xffd76a, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const spr = new THREE.Sprite(mat);
      spr.scale.setScalar(0.12 + Math.random() * 0.12);
      spr.position.copy(h.mesh.position);
      scene.add(spr);
      pokerClearParticles.push({
        sprite: spr,
        vel: new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.5, (Math.random() - 0.5) * 0.6),
      });
    }
  }
}

function updatePokerClearing(dt) {
  const s = Math.min(1, pokerStateTimer / POKER_CLEAR_DURATION);
  for (const h of [...playerHand, ...dealerHand]) h.mesh.scale.setScalar(Math.max(0.001, 1 - s));
  for (const p of pokerClearParticles) {
    p.sprite.position.addScaledVector(p.vel, dt);
    p.sprite.material.opacity = Math.max(0, 0.9 * (1 - s));
  }
  if (s >= 1) {
    for (const p of pokerClearParticles) scene.remove(p.sprite);
    pokerClearParticles = [];
    clearPokerCards();
    pokerState = 'idle';
  }
}

function updatePokerDealing() {
  let allDone = true;
  for (let i = 0; i < pokerDealQueue.length; i++) {
    const startAt = i * POKER_DEAL_INTERVAL;
    const localT = pokerDealTimer - startAt;
    if (localT < 0) { allDone = false; continue; }
    const s = Math.min(1, localT / POKER_DEAL_ANIM_DURATION);
    pokerDealQueue[i].scale.setScalar(0.001 + 0.999 * s);
    if (s < 1) allDone = false;
  }
  if (allDone) {
    pokerDealQueue = [];
    pokerState = pokerAfterDealState;
    pokerStateTimer = 0;
    if (pokerState === 'playerTurn') {
      pokerPanelEl.classList.add('show');
      refreshPokerHint();
    }
  }
}

function updatePoker(dt) {
  // 選択中のプレイヤーカードは少し持ち上がる（dealing/clearing中はここでは動かさない）
  if (pokerState === 'playerTurn' || pokerState === 'dealerTurn' || pokerState === 'showdown' || pokerState === 'result') {
    for (const h of playerHand) {
      const targetY = POKER_PLAYER_Y + (h.selected ? POKER_SELECT_LIFT : 0);
      h.mesh.position.y += (targetY - h.mesh.position.y) * Math.min(1, dt * 8);
    }
  }
  switch (pokerState) {
    case 'dealing':
      pokerDealTimer += dt;
      updatePokerDealing();
      break;
    case 'dealerTurn':
      pokerStateTimer += dt;
      if (pokerStateTimer > POKER_DEALER_THINK_DURATION) resolveDealerTurn();
      break;
    case 'showdown':
      pokerStateTimer += dt;
      if (pokerStateTimer > POKER_SHOWDOWN_REVEAL_DURATION) resolveShowdown();
      break;
    case 'result':
      pokerStateTimer += dt;
      if (pokerStateTimer > POKER_RESULT_HOLD_DURATION) startPokerClearing();
      break;
    case 'clearing':
      pokerStateTimer += dt;
      updatePokerClearing(dt);
      break;
  }
}

// ---------- ルーレット（穴に10枚たまったら起動するボーナス抽選） ----------
// 穴に落ちた10枚はスコアにはならない特別枠（相談で確定済み）。ルーレットの結果は
// 「当選ボーナス分のコインが画面上から山へ降り注ぐ」演出で受け取る。降ってきたコインは
// 通常のコインと同じ物理挙動をするため、そこから先はプッシャーで押して普通にGETを狙う。
// セグメントは「当たりやすい少額」〜「レアな大当たり」まで重み付き。ハズレ（0枚）は
// 設けていない（相談時点では明示的な「損」要素は要求されていないため、まずは前向きな
// ボーナスラウンドとして実装。損失リスクが欲しければ次回相談）。
// カジノの高級感を意識し、ルビー（濃赤）×エメラルド（濃緑）を交互に、レア枠は
// サファイア（濃紺）、大当たりは金地にして一目で特別と分かるようにしている
// 【追加】宝石の供給源をルーレットの当たりに変更（テツさま指示）。宝石が出た時は
// コイン枚数ではなく「ルーレットの一番多い数（50）ぶんタワー/プッシャーに貯まる」扱いとし、
// 特別枠として一目で分かるよう紫の宝石調カラー＋💎表示にする
// 【Step4】実際に回転しているホイールをスペースキーで直接止める目押し方式に変更したため、
// 「必ず何かに当たる」旧仕様をやめ、ハズレ（reward:0）枠を新設した。weightは見た目の
// 角度（＝目押しの狙いやすさ）にそのまま直結する。出現率・配分は暫定値・要実機確認。
const ROULETTE_SEGMENTS = [
  { reward: 5, weight: 16, color: '#7a1020' },
  { reward: 0, weight: 20, color: '#1a1a1a', isMiss: true },
  { reward: 10, weight: 14, color: '#0d3d2c' },
  { reward: 0, weight: 16, color: '#1a1a1a', isMiss: true },
  { reward: 15, weight: 11, color: '#7a1020' },
  { reward: 0, weight: 10, color: '#1a1a1a', isMiss: true },
  { reward: 20, weight: 8, color: '#0d3d2c' },
  { reward: 30, weight: 5, color: '#1c1f52' },
  { reward: 50, weight: 2, color: '#d9b65c' },
  { reward: 50, weight: 3, color: '#4a1f5c', isGem: true },
];
{
  const total = ROULETTE_SEGMENTS.reduce((s, seg) => s + seg.weight, 0);
  let acc = 0;
  for (const seg of ROULETTE_SEGMENTS) {
    seg.start = (acc / total) * Math.PI * 2;
    acc += seg.weight;
    seg.end = (acc / total) * Math.PI * 2;
  }
}

const rouletteCanvas = document.getElementById('rouletteWheel');
const rouletteCtx = rouletteCanvas.getContext('2d');
// カジノの本物のルーレット盤をイメージした高級感のある描画（金属リム・電球風スタッド・
// 宝石調センターハブ・セリフ体の刻印風数字）に作り直した
function drawRouletteWheel() {
  const cx = rouletteCanvas.width / 2, cy = rouletteCanvas.height / 2;
  const outerR = cx - 3;
  const rimW = 11;
  const wheelR = outerR - rimW;
  rouletteCtx.clearRect(0, 0, rouletteCanvas.width, rouletteCanvas.height);

  // 外周：金属質のゴールドリム
  const rimGrad = rouletteCtx.createLinearGradient(0, 0, rouletteCanvas.width, rouletteCanvas.height);
  rimGrad.addColorStop(0, '#fff6da');
  rimGrad.addColorStop(0.25, '#caa53d');
  rimGrad.addColorStop(0.5, '#7a5a1a');
  rimGrad.addColorStop(0.75, '#e8cd7a');
  rimGrad.addColorStop(1, '#b8933f');
  rouletteCtx.beginPath();
  rouletteCtx.arc(cx, cy, outerR, 0, Math.PI * 2);
  rouletteCtx.fillStyle = rimGrad;
  rouletteCtx.fill();

  // セグメント（宝石調カラー）
  for (const seg of ROULETTE_SEGMENTS) {
    rouletteCtx.beginPath();
    rouletteCtx.moveTo(cx, cy);
    rouletteCtx.arc(cx, cy, wheelR, seg.start, seg.end);
    rouletteCtx.closePath();
    rouletteCtx.fillStyle = seg.color;
    rouletteCtx.fill();
  }

  // セグメント境界の金の仕切り線
  rouletteCtx.strokeStyle = '#e8cd7a';
  rouletteCtx.lineWidth = 2;
  for (const seg of ROULETTE_SEGMENTS) {
    rouletteCtx.beginPath();
    rouletteCtx.moveTo(cx, cy);
    rouletteCtx.lineTo(cx + Math.cos(seg.start) * wheelR, cy + Math.sin(seg.start) * wheelR);
    rouletteCtx.stroke();
  }

  // リム上の電球風スタッド
  const studCount = 20;
  for (let i = 0; i < studCount; i++) {
    const a = (i / studCount) * Math.PI * 2;
    const sx = cx + Math.cos(a) * (wheelR + rimW / 2);
    const sy = cy + Math.sin(a) * (wheelR + rimW / 2);
    rouletteCtx.beginPath();
    rouletteCtx.arc(sx, sy, 2.1, 0, Math.PI * 2);
    rouletteCtx.fillStyle = '#fff8e6';
    rouletteCtx.fill();
    rouletteCtx.strokeStyle = 'rgba(90, 60, 10, 0.6)';
    rouletteCtx.lineWidth = 0.6;
    rouletteCtx.stroke();
  }

  // 数字（セリフ体・刻印風シャドウ。大当たり枠は金地なので焦げ茶で視認性を確保）
  for (const seg of ROULETTE_SEGMENTS) {
    const mid = (seg.start + seg.end) / 2;
    rouletteCtx.save();
    rouletteCtx.translate(cx + Math.cos(mid) * wheelR * 0.63, cy + Math.sin(mid) * wheelR * 0.63);
    rouletteCtx.rotate(mid + Math.PI / 2);
    rouletteCtx.shadowColor = 'rgba(0,0,0,0.7)';
    rouletteCtx.shadowBlur = 3;
    if (seg.isGem) {
      // 宝石枠は数字ではなく💎マークで一目で特別と分かるようにする
      rouletteCtx.font = '700 26px sans-serif';
      rouletteCtx.textAlign = 'center';
      rouletteCtx.textBaseline = 'middle';
      rouletteCtx.fillText('💎', 0, 2);
    } else if (seg.isMiss) {
      // ハズレ枠は✕マークで一目で分かるようにする
      rouletteCtx.fillStyle = '#8a8a8a';
      rouletteCtx.font = '700 22px sans-serif';
      rouletteCtx.textAlign = 'center';
      rouletteCtx.textBaseline = 'middle';
      rouletteCtx.fillText('✕', 0, 2);
    } else {
      rouletteCtx.fillStyle = seg.reward === 50 ? '#3a2200' : '#f3d98b';
      rouletteCtx.font = '700 25px Georgia, "Hiragino Mincho ProN", serif';
      rouletteCtx.textAlign = 'center';
      rouletteCtx.textBaseline = 'middle';
      rouletteCtx.fillText(String(seg.reward), 0, -6);
      rouletteCtx.font = '600 11px Georgia, serif';
      rouletteCtx.fillText('枚', 0, 13);
    }
    rouletteCtx.restore();
  }

  // 中央のゴールド×ルビーのセンターハブ
  const hubGrad = rouletteCtx.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, 19);
  hubGrad.addColorStop(0, '#fff6da');
  hubGrad.addColorStop(0.55, '#d9b65c');
  hubGrad.addColorStop(1, '#7a5a1a');
  rouletteCtx.beginPath();
  rouletteCtx.arc(cx, cy, 18, 0, Math.PI * 2);
  rouletteCtx.fillStyle = hubGrad;
  rouletteCtx.fill();
  rouletteCtx.strokeStyle = '#4a3610';
  rouletteCtx.lineWidth = 1.5;
  rouletteCtx.stroke();
  const gemGrad = rouletteCtx.createRadialGradient(cx - 2, cy - 2, 0.5, cx, cy, 6);
  gemGrad.addColorStop(0, '#ff6a8a');
  gemGrad.addColorStop(1, '#7a1020');
  rouletteCtx.beginPath();
  rouletteCtx.arc(cx, cy, 6, 0, Math.PI * 2);
  rouletteCtx.fillStyle = gemGrad;
  rouletteCtx.fill();
}
drawRouletteWheel();

const rouletteOverlayEl = document.getElementById('rouletteOverlay');
const rouletteResultEl = document.getElementById('rouletteResult');
const rouletteAimHintEl = document.getElementById('rouletteAimHint');
const ROULETTE_SPIN_SPEED = 6.0;   // ホイールの回転速度（rad/秒。暫定値・要実機確認）
const ROULETTE_AIM_TIMEOUT = 10.0; // これだけ放置したら、その時点の位置で自動的に止める（無限待ち防止）
let rouletteState = 'idle'; // 'idle' | 'playing'（回転中・目押し受付中） | 'result'
let rouletteTimer = 0;
let rouletteAimT = 0; // 'playing'状態の経過時間（タイムアウト判定に使う）
let rouletteCurrentAngle = 0;
let rouletteReward = 0;
let rouletteGrantsGem = false; // 追加：この回の当たりが宝石かどうか
let rainQueueCount = 0; // 演出後、山へ降らせる残りコイン数
let rainTimer = 0;
const RAIN_INTERVAL = 0.09;

// 【Step4】実際に回転しているホイールを目押しする方式に変更。結果を先に決めるのではなく、
// ホイールを回転させ続け、スペースキー（またはタイムアウト）が押された瞬間にポインターが
// 指しているセグメントをそのまま結果として採用する。
function startRoulette() {
  rouletteState = 'playing';
  rouletteAimT = 0;
  rouletteResultEl.textContent = '';
  rouletteOverlayEl.classList.add('show');
}

// スペース押下（またはタイムアウト）で、その瞬間ホイールが指しているセグメントを結果として確定する。
// ポインターは12時（真上）固定。startRoulette側にあった旧・逆算式(target = -PI/2 - landAngle)の
// 関係をそのまま逆に解いて、現在の回転角からポインターが指すセグメントを求める。
function stopRouletteAim() {
  if (rouletteState !== 'playing') return;
  const TWO_PI = Math.PI * 2;
  const localAngle = (((-Math.PI / 2 - rouletteCurrentAngle) % TWO_PI) + TWO_PI) % TWO_PI;
  const seg = ROULETTE_SEGMENTS.find((s) => localAngle >= s.start && localAngle < s.end)
    || ROULETTE_SEGMENTS[ROULETTE_SEGMENTS.length - 1];
  rouletteReward = seg.reward;
  rouletteGrantsGem = !!seg.isGem;
  rouletteState = 'result';
  rouletteTimer = 0;
  rouletteResultEl.textContent = seg.isMiss ? '残念…ハズレ！' : (rouletteGrantsGem ? '💎 誕生石 GET！' : `+${rouletteReward} 枚！`);
}

// ---------- ジャックポットスロット（誕生石12種類をすべて収集すると起動） ----------
// 【Step4】3リールが同時に回転を開始し、スペースキーを押すたびに1本ずつ、押した瞬間の
// 位置から最寄りのシンボルへスナップして止める（実機スロットの「滑り込み」に近い挙動）。
// 当たりシンボル（各リールの位置0に固定）との円環距離が許容誤差以内なら、そのリールは
// 成功として当たりシンボルへピタリと吸着させる。外れの場合は素直に最寄りの実シンボルへ
// スナップする。3本すべて成功して初めて大当たり。速度・許容誤差はどちらもjpTowerStageに
// 応じて緩和する（タワーが育つほど遅く・広くなる救済システム。旧・ゾーン幅拡大と同じ考え方）。
const JACKPOT_MIN_REWARD = 100;
const JACKPOT_MAX_REWARD = 200;
const JACKPOT_DECO_SYMBOLS = ['⭐', '🔶', '✨', '7️⃣'];
const JACKPOT_WIN_SYMBOL = '💎';
const JP_REEL_COUNT = 3;
const JP_REEL_LEN = 8;           // 1リールのシンボル数（インデックス0が常にWIN_SYMBOL）
const JACKPOT_SYM_SIZE = 56;     // CSSの .sym の高さと合わせること
const JP_REEL_SPEED_MAX = 3.4;   // 段階0（最難）でのリール速度（symbols/秒。暫定値・要実機確認）
const JP_REEL_SPEED_MIN = 1.0;   // 最大段階（最易）でのリール速度
const JP_REEL_TOL_MIN = 0.18;    // 段階0での許容誤差（シンボル単位、当たり位置からの円環距離）
const JP_REEL_TOL_MAX = 3.6;     // 最大段階での許容誤差（8シンボル中ほぼ全域をカバー＝ほぼ確実に成功）
const JP_REEL_TIMEOUT = 8.0;     // 1本あたりこれだけ放置したら、その時点の位置で自動停止する（無限待ち防止）

const jackpotOverlayEl = document.getElementById('jackpotOverlay');
const jackpotResultEl = document.getElementById('jackpotResult');
const jackpotAimHintEl = document.getElementById('jackpotAimHint');
const jackpotReelEls = [
  document.getElementById('reel0'),
  document.getElementById('reel1'),
  document.getElementById('reel2'),
];
const jackpotReelStripEls = [
  document.getElementById('reelStrip0'),
  document.getElementById('reelStrip1'),
  document.getElementById('reelStrip2'),
];
// 'idle' | 'playing'（3リールが回転中〜1本ずつ止めている最中） | 'result'
let jackpotState = 'idle';
let jackpotTimer = 0;
let jackpotReward = 0;
let jackpotSuccess = false;
let jpActiveReel = 0;      // 次にスペースで止める対象のリール（0〜2）
let jpActiveReelTimer = 0; // 現在のリールが回り始めてからの経過時間（タイムアウト判定用）
const jpReelSpinning = [false, false, false];
const jpReelPhase = [0, 0, 0];    // 各リールの現在位置（シンボル単位の連続値、0〜JP_REEL_LEN未満）
const jpReelSuccess = [false, false, false];

// シンボル配列を2周ぶん並べる（継ぎ目なく無限スクロールさせるための定石。位置0〜JP_REEL_LENの
// 範囲でtranslateYしても、1周先のコピーが同じ内容のため境目が視覚的に分からない）
function buildReelStrip(el) {
  el.innerHTML = '';
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < JP_REEL_LEN; i++) {
      const sym = document.createElement('div');
      sym.className = 'sym';
      sym.textContent = i === 0 ? JACKPOT_WIN_SYMBOL : JACKPOT_DECO_SYMBOLS[(i - 1) % JACKPOT_DECO_SYMBOLS.length];
      el.appendChild(sym);
    }
  }
}
jackpotReelStripEls.forEach(buildReelStrip);

function jpDifficultyT() {
  return Math.min(jpTowerStage, JP_TOWER_MAX_STAGE) / JP_TOWER_MAX_STAGE;
}
function jpReelSpeed() {
  return JP_REEL_SPEED_MAX - (JP_REEL_SPEED_MAX - JP_REEL_SPEED_MIN) * jpDifficultyT();
}
function jpReelTolerance() {
  return JP_REEL_TOL_MIN + (JP_REEL_TOL_MAX - JP_REEL_TOL_MIN) * jpDifficultyT();
}

function updateReelTransform(i) {
  jackpotReelStripEls[i].style.transform = `translateY(-${jpReelPhase[i] * JACKPOT_SYM_SIZE}px)`;
}

function updateJackpotHintUI() {
  jackpotAimHintEl.textContent = `スペースキーでリールを止めろ！（${jpActiveReel + 1} / ${JP_REEL_COUNT}本目）`;
  jackpotReelEls.forEach((el, i) => el.classList.toggle('active', jackpotState === 'playing' && i === jpActiveReel));
}

// 誕生石12種コンプで呼ばれる。3リールを同時に回転開始し、1本ずつスペースキーで止めさせる。
function startJackpot() {
  jackpotState = 'playing';
  jackpotResultEl.textContent = '';
  jackpotOverlayEl.classList.add('show');
  jpActiveReel = 0;
  jpActiveReelTimer = 0;
  for (let i = 0; i < JP_REEL_COUNT; i++) {
    jpReelSpinning[i] = true;
    jpReelPhase[i] = Math.random() * JP_REEL_LEN; // 毎回同じ絵から始まらないよう、ランダムな位置から回転開始
    jpReelSuccess[i] = false;
    updateReelTransform(i);
  }
  updateJackpotHintUI();
}

// スペース押下（またはタイムアウト）で現在アクティブなリールを止める。停止位置と当たり
// シンボル（インデックス0）との円環距離が許容誤差以内なら成功として当たりシンボルへ
// ピタリと吸着させ、外れの場合は最寄りの実シンボルへ素直にスナップする。
function stopActiveReel() {
  if (jackpotState !== 'playing' || jpActiveReel >= JP_REEL_COUNT) return;
  const i = jpActiveReel;
  const phase = ((jpReelPhase[i] % JP_REEL_LEN) + JP_REEL_LEN) % JP_REEL_LEN;
  const dist = Math.min(phase, JP_REEL_LEN - phase); // 当たり位置(0)からの円環距離
  const success = dist <= jpReelTolerance();
  jpReelSpinning[i] = false;
  jpReelSuccess[i] = success;
  jpReelPhase[i] = success ? 0 : Math.round(phase) % JP_REEL_LEN;
  updateReelTransform(i);
  jpActiveReel++;
  jpActiveReelTimer = 0;
  if (jpActiveReel >= JP_REEL_COUNT) {
    finishJackpotReels();
  } else {
    updateJackpotHintUI();
  }
}

function finishJackpotReels() {
  jackpotSuccess = jpReelSuccess.every(Boolean);
  jackpotReward = jackpotSuccess
    ? JACKPOT_MIN_REWARD + Math.floor(Math.random() * (JACKPOT_MAX_REWARD - JACKPOT_MIN_REWARD + 1))
    : 0;
  jackpotState = 'result';
  jackpotTimer = 0;
  jackpotResultEl.textContent = jackpotSuccess ? `JACKPOT! +${jackpotReward} 枚！` : '残念…外れ！';
}

// worldY/worldZ/initialVelocity/initialQuaternion/initialAngularVelocity/rollUntil を省略すると
// 通常の落下投入（一番奥からランダムに落下、最初から水平）になる。
// レーン投入では、レール終端での位置・速度・姿勢・角速度をそのまま引き継いでここに渡すことで、
// 着地後も慣性で転がり続け、どちらに倒れ込むかは物理まかせのランダムな結果になる。
// rollUntil を指定すると、その時刻（clock.elapsedTime基準）までは「倒れ防止」の
// 強制ロックの対象から外れ、自然に転がり続けられる。
function spawnCoin(worldX, worldY, worldZ, initialVelocity, initialQuaternion, initialAngularVelocity, rollUntil) {
  if (coins.length >= MAX_COINS) {
    const oldest = coins.shift();
    scene.remove(oldest.mesh);
    world.removeBody(oldest.body);
  }
  const mat = Math.random() < 0.75 ? coinMatGold : coinMatSilver;
  const mesh = new THREE.Mesh(coinGeo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  const body = new CANNON.Body({
    // 実物の金属コインらしい重みを出すため質量を増加、減衰もやや強めて着地後の余計な揺れを抑える
    mass: 0.55,
    material: matCoin,
    linearDamping: 0.05,
    angularDamping: 0.65,
    // 着地後に微振動したままスリープしない状態を防ぐため、既定よりゆるい条件で早めに眠らせる
    sleepSpeedLimit: 0.2,
    sleepTimeLimit: 0.25,
    // angularFactorは何かに接触している間だけ毎フレーム(0,1,0)に絞り、倒れる方向の
    // 回転を防ぐ（下記メインループ参照）。空中（自由落下中）はデフォルトの(1,1,1)の
    // ままにしておき、プッシャーのヘリ等から落ちる時は自然にコロンと転がって見えるようにする。
  });
  // 見た目のメッシュは28角形のまま。当たり判定だけ8角形に簡略化してSAT衝突判定のコストを削減する。
  body.addShape(new CANNON.Cylinder(COIN_RADIUS, COIN_RADIUS, COIN_HEIGHT, 8));
  const y = worldY !== undefined ? worldY : SPAWN_Y + Math.random() * 0.6;
  const z = worldZ !== undefined ? worldZ : SPAWN_Z + (Math.random() - 0.5) * 0.3;
  body.position.set(worldX, y, z);
  if (initialVelocity) body.velocity.copy(initialVelocity);
  if (initialAngularVelocity) body.angularVelocity.copy(initialAngularVelocity);
  if (initialQuaternion) {
    body.quaternion.copy(initialQuaternion);
  } else {
    // 倒れる方向の回転を禁止するため、最初から水平（X/Zチルトなし）で生成する
    body.quaternion.setFromEuler(0, Math.random() * Math.PI, 0);
  }
  world.addBody(body);

  coins.push({ mesh, body, rollUntil: rollUntil || 0, spawnT: clock.elapsedTime, idleSince: null, archPassed: false });
}

function clampSpawnX(x) {
  const m = FIELD_HALF_X - 0.4;
  return Math.max(-m, Math.min(m, x));
}

// ---------- レーン投入（画面左右のレールからコインが転がってプッシャーに落ちる演出） ----------
// レール区間は物理演算に参加させず、見た目だけの簡易アニメーションで転がす。
// 終端に到達したら、その時点の速度・角速度・姿勢を引き継いで通常のコインとして
// 物理ワールドへ渡す（＝着地後も慣性で転がり続け、どちらに倒れるかは物理まかせになる）。
const RAIL_DURATION = 1.0; // 秒
const RAIL_START_Y = 2.6;
const RAIL_END_Y = 0.7;
const RAIL_START_Z = -1.3;
const RAIL_X_OUTER = 6.3; // レール開始点のX（左右対称）
const RAIL_X_INNER = 2.4; // レール終了点のX（左右対称）
// 投入位置（奥⇔手前）の調整範囲。手前側はプッシャーの最小到達点（PUSHER_BACK_Z+1.0）を
// 少し超えるところまで許可（約15度分、手前に多く振れるように拡張）。プッシャーが
// 縮み切っている一瞬だけは床に落ちることもあるが、その場合も床の上で普通に着地するだけなので
// 破綻はしない。
const RAIL_END_Z_MIN = PUSHER_BACK_Z + 0.3; // 奥寄り
const RAIL_END_Z_MAX = -1.6; // 手前寄り
let railEndZ = RAIL_END_Z_MAX;

// テツさま指示（2026-08-12）で「カーブを付ける」よう変更。直線ではなく、中間に制御点を
// 1つ置いたQuadraticBezierCurve3で緩やかな弧を描く経路にする。制御点は直線の中点より
// さらに外側（X方向）にふくらませ、上から見て緩やかな弧を描くようにしている（Y方向は
// 重力で落ちていく自然な感覚を壊さないよう直線の中点のままにし、山なりにはしない）。
const RAIL_CURVE_BULGE = 0.75;
function railPoints(side) {
  const start = new THREE.Vector3(side * RAIL_X_OUTER, RAIL_START_Y, RAIL_START_Z);
  const end = new THREE.Vector3(side * RAIL_X_INNER, RAIL_END_Y, railEndZ);
  const mid = start.clone().lerp(end, 0.5);
  mid.x += side * RAIL_CURVE_BULGE;
  const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
  return { start, end, mid, curve };
}

// 「ただの板」という指摘を受けゴールドのU字チャンネル（底板＋両サイドの立ち上がり）に
// 刷新したが、テツさま指示（2026-08-12）で「幅を狭く」「手すりのように、細い金が
// レールガイドをしているデザインに」とさらに刷新。太い側壁は廃し、コインが実際に
// 転がる細いトラック（円形断面のチューブ）＋その両脇を少し高い位置で並走する、
// 手すりのように細いゴールドのガイドロッド（2本）という構成に変更した。
const RAIL_TRACK_RADIUS = 0.085; // 幅を狭く（旧: 底板幅0.5 → トラック直径0.17相当）
const RAIL_GUIDE_RADIUS = 0.026; // 手すりのように細いガイドロッド
const RAIL_GUIDE_OFFSET = 0.16;  // トラック中心からガイドロッドまでの左右オフセット
// テツさま指示（2026-08-12）で「もう少し針金の位置を上に」。旧値0.05だと下端
// （0.05-0.026=0.024）がトラック上面（0.085）より低く、手すりというより埋もれて
// 見えていたため、トラック上面よりはっきり高い位置まで引き上げる
const RAIL_GUIDE_LIFT = 0.2;     // ガイドロッドをトラック面よりはっきり高く（手すりらしく）
// テツさま指摘「レーンがコインを貫通して見える」への対応：転がるコインの描画位置を
// カーブ（トラックの中心線）にそのまま置くと、コインの中心がトラック断面の内部に
// めり込んで見えてしまう。トラック表面（半径ぶん）＋コインが実際に転がって乗る分
// （コインは縦に立った姿勢で転がるため、接地点からコイン中心までの距離はコイン半径に
// 近い）だけ持ち上げて、トラックの上に乗っているように補正する
const RAIL_COIN_LIFT = RAIL_TRACK_RADIUS + COIN_RADIUS * 0.92;
const RAIL_CURVE_SEGMENTS = 20;  // カーブの滑らかさ（TubeGeometryの分割数）

const railTrackMat = new THREE.MeshStandardMaterial({ color: 0xc9a552, metalness: 0.8, roughness: 0.26, emissive: 0x1a1204 });
const railGuideMat = new THREE.MeshStandardMaterial({ color: 0xf3d98b, metalness: 0.92, roughness: 0.12 });

// 環境マップ（metalEnvTexture）は金属質パーツのみへ個別適用（上記のパフォーマンス判断コメント参照）
// 【㊵】コインは単一アトラスマテリアルに戻したため配列展開は不要
// 【㊻】envMapIntensityを1.0→2.2へ引き上げ、上記の煌めきスポット追加と合わせて
// 金属らしい鋭い反射を出す（宝石の3.4ほど強くはしない＝金属とは質感が異なるため）
for (const m of [coinMatGold, coinMatSilver, trimMat, gateMat, ballMat, railTrackMat, railGuideMat]) {
  m.envMap = metalEnvTexture;
  m.envMapIntensity = 2.2;
  m.needsUpdate = true;
}

// カーブ上の各点で、進行方向（接線）とワールド上方向の外積から左右方向を求め、その方向に
// RAIL_GUIDE_OFFSETだけずらした点列からCatmullRomCurve3を作る。ベジェ曲線に厳密に平行な
// オフセット曲線ではないが、緩やかな弧である今回の用途では見た目上ほぼ平行に走って見える。
function railGuideCurve(curve, offsetSign) {
  const pts = [];
  for (let i = 0; i <= RAIL_CURVE_SEGMENTS; i++) {
    const u = i / RAIL_CURVE_SEGMENTS;
    const p = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u);
    const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
    pts.push(p.clone().addScaledVector(side, offsetSign * RAIL_GUIDE_OFFSET).add(new THREE.Vector3(0, RAIL_GUIDE_LIFT, 0)));
  }
  return new THREE.CatmullRomCurve3(pts);
}

function makeRailMesh() {
  const group = new THREE.Group();
  const track = new THREE.Mesh(new THREE.BufferGeometry(), railTrackMat);
  track.castShadow = true;
  track.receiveShadow = true;
  group.add(track);
  const guideL = new THREE.Mesh(new THREE.BufferGeometry(), railGuideMat);
  guideL.castShadow = true;
  group.add(guideL);
  const guideR = new THREE.Mesh(new THREE.BufferGeometry(), railGuideMat);
  guideR.castShadow = true;
  group.add(guideR);
  scene.add(group);
  return { group, track, guideL, guideR };
}
const railMeshRight = makeRailMesh();
const railMeshLeft = makeRailMesh();

// カーブが変わる（初期化時・投入位置スライダー操作時）たびにチューブ形状を作り直す。
// TubeGeometryはカーブから頂点を一度だけ計算する仕組みのため、Boxのscaleのように
// 使い回すことができず、都度dispose＋再生成する必要がある（毎フレームではなく
// スライダー操作時のみ呼ばれるので、コストは問題にならない）。
function rebuildRailGeometry(railMesh, side) {
  const { curve } = railPoints(side);
  railMesh.track.geometry.dispose();
  railMesh.track.geometry = new THREE.TubeGeometry(curve, RAIL_CURVE_SEGMENTS, RAIL_TRACK_RADIUS, 8, false);
  railMesh.guideL.geometry.dispose();
  railMesh.guideL.geometry = new THREE.TubeGeometry(railGuideCurve(curve, 1), RAIL_CURVE_SEGMENTS, RAIL_GUIDE_RADIUS, 6, false);
  railMesh.guideR.geometry.dispose();
  railMesh.guideR.geometry = new THREE.TubeGeometry(railGuideCurve(curve, -1), RAIL_CURVE_SEGMENTS, RAIL_GUIDE_RADIUS, 6, false);
}

function updateRailVisuals() {
  rebuildRailGeometry(railMeshRight, 1);
  rebuildRailGeometry(railMeshLeft, -1);
}
updateRailVisuals();

const rollingCoins = []; // { mesh, t, side, spinSign }

function spawnRailCoin(side) {
  if (!spendCredit()) return; // 本番モードでクレジット0/GameOver中はレーン投入を無効化
  const { start, end } = railPoints(side);
  const mat = Math.random() < 0.75 ? coinMatGold : coinMatSilver;
  const mesh = new THREE.Mesh(coinGeo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.copy(start);
  mesh.position.y += RAIL_COIN_LIFT;
  // 円柱の軸（見た目上の厚み方向）を水平に倒し、進行方向に垂直な軸まわりに転がるようにする
  mesh.rotation.set(Math.PI / 2, 0, 0);
  scene.add(mesh);
  // 転がる向き（回転の符号）はX方向の進行方向で決まる。右レーン（X減少方向）と
  // 左レーン（X増加方向）で符号が逆になるのに固定値を使っていたため、左レーンだけ
  // 「転がりながら進む」物理的につじつまの合わない状態になり、着地直後に破綻していた。
  const dirX = end.x - start.x;
  const spinSign = dirX > 0 ? -1 : 1;
  // 終端は固定値ではなく side を保持し、毎フレーム railPoints() から取り直す。
  // 投入後にスライダーで角度を変えても、移動中のコインがその変更（＝新しいカーブ）を
  // 反映するようにするため（以前は投入した瞬間の終端に固定されており反映されなかった）。
  rollingCoins.push({ mesh, t: 0, side, spinSign });
}

// ---------- 入力：クリック / タップで投入位置を決める ----------
const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SPAWN_Y);
const pointerNDC = new THREE.Vector2();

function insertAtClient(clientX, clientY) {
  pointerNDC.x = (clientX / window.innerWidth) * 2 - 1;
  pointerNDC.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(aimPlane, hit)) {
    spawnCoin(clampSpawnX(hit.x));
  } else {
    spawnCoin(clampSpawnX((Math.random() - 0.5) * FIELD_HALF_X * 2));
  }
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (pokerState === 'playerTurn') {
    // ポーカー中はカード選択のみ受け付け、通常のコイン投入は行わない
    pointerNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointerNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObjects(playerHand.map(h => h.mesh), false);
    if (hits.length > 0) {
      const entry = playerHand.find(h => h.mesh === hits[0].object);
      if (entry) {
        entry.selected = !entry.selected;
        setCardSelectedVisual(entry.mesh, entry.selected);
        refreshPokerHint();
      }
    }
    return;
  }
  if (pokerState !== 'idle') return; // ポーカー進行中（dealing/dealerTurn等）はコイン投入も無効化
  if (productionMode) return; // 本番モードはレーン投入のみ。画面クリックでの直接投入は無効化する
  insertAtClient(e.clientX, e.clientY);
});

document.getElementById('btnInsert').addEventListener('click', (e) => {
  e.stopPropagation();
  spawnCoin(clampSpawnX((Math.random() - 0.5) * FIELD_HALF_X * 1.6));
});

document.getElementById('btnBall').addEventListener('click', (e) => {
  e.stopPropagation();
  spawnBall();
});

document.getElementById('btnGem').addEventListener('click', (e) => {
  e.stopPropagation();
  spawnGem();
});

document.getElementById('btnRailRight').addEventListener('click', (e) => {
  e.stopPropagation();
  spawnRailCoin(1);
});

document.getElementById('btnRailLeft').addEventListener('click', (e) => {
  e.stopPropagation();
  spawnRailCoin(-1);
});

const railZSlider = document.getElementById('railZSlider');
railZSlider.addEventListener('input', (e) => {
  e.stopPropagation();
  const t = railZSlider.value / 100; // 0=奥、100=手前
  railEndZ = RAIL_END_Z_MIN + (RAIL_END_Z_MAX - RAIL_END_Z_MIN) * t;
  updateRailVisuals();
});

let autoInsert = false;
document.getElementById('btnAuto').addEventListener('click', (e) => {
  e.stopPropagation();
  autoInsert = !autoInsert;
  e.target.textContent = autoInsert ? 'オート投入: ON' : 'オート投入: OFF';
  e.target.classList.toggle('toggled', autoInsert);
});

document.getElementById('btnBurst').addEventListener('click', (e) => {
  e.stopPropagation();
  for (let i = 0; i < 50; i++) {
    spawnCoin(clampSpawnX((Math.random() - 0.5) * FIELD_HALF_X * 2));
  }
});

// 【テスト用】実機確認のため、達成条件を満たさなくても演出を手動発動できるボタン。
// 確認が済んだら削除する想定（達成条件そのものは変更しない）。
document.getElementById('btnForceJackpot').addEventListener('click', (e) => {
  e.stopPropagation();
  if (jackpotState === 'idle') startJackpot();
});

document.getElementById('btnForceRoulette').addEventListener('click', (e) => {
  e.stopPropagation();
  if (rouletteState === 'idle') startRoulette();
});

// 【Step4】キーボード操作一式：スペース＝JPリール/ルーレットの目押し確定、
// A＝左レーン投入、L＝右レーン投入、↑↓＝レーン角度調整（奥⇔手前スライダーと同じ値を操作）。
// レーン投入はspawnRailCoin()をボタンクリックと共通で呼ぶため、本番/テストモードの
// クレジット消費制限もそのまま適用される。
const RAIL_ANGLE_KEY_STEP = 6; // 1回の↑↓でrailZSlider（0〜100）を動かす量
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (jackpotState === 'playing') stopActiveReel();
    else if (rouletteState === 'playing') stopRouletteAim();
    return;
  }
  if (e.key === 'a' || e.key === 'A') { spawnRailCoin(-1); return; }
  if (e.key === 'l' || e.key === 'L') { spawnRailCoin(1); return; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const delta = e.key === 'ArrowUp' ? RAIL_ANGLE_KEY_STEP : -RAIL_ANGLE_KEY_STEP;
    railZSlider.value = Math.max(0, Math.min(100, Number(railZSlider.value) + delta));
    railZSlider.dispatchEvent(new Event('input'));
  }
});

document.getElementById('btnReset').addEventListener('click', (e) => {
  e.stopPropagation();
  for (const c of coins) {
    scene.remove(c.mesh);
    world.removeBody(c.body);
  }
  coins.length = 0;
  score = 0;
  updateScoreUI();
  for (const g of gems) {
    scene.remove(g.mesh);
    for (const s of g.glint.sprites) scene.remove(s);
    world.removeBody(g.body);
  }
  gems.length = 0;
  collectedGems.clear();
  updateGemTrackerUI();
  // レール上を移動中（まだ物理コインになっていない）のコインも一掃する。
  // 【正直な記録】旧来はここが未対応で、リセット直前にレーン投入したコインが
  // リセット後にレール上をそのまま転がり続けて追加出現する不具合があった
  // （クレジット制導入でリセット＝ゲーム再スタートの意味を持つようになり顕在化したため今回対応）。
  for (const rc of rollingCoins) scene.remove(rc.mesh);
  rollingCoins.length = 0;
  resetCredits();
  scatterInitialCoins();
});

// ---------- クレジット制（初期50枚、0でGameOver） ----------
// 本番モードでのみ消費・GameOver判定が働く。テストモードはオート投入・バースト投入・
// クリック投入等の他の検証用機能と同様、クレジットを消費せず投入し放題にする
// （消費対象は本番モードで唯一許可される投入手段＝レーン投入のみ）。
// 【正直な記録】仕様書の「落としたコインは入手コインとして使用可能」は、通常の得点
// (score++、コインが得点ラインを超えた瞬間)だけでなく、コインレール（大当たり演出）
// 解放によるGET加算も対象に含めた（どちらも「コインが得点になった」瞬間のため）。
// クレジット獲得自体はモードを問わず常時有効にしている（テストモード中に増えても、
// 消費・GameOver判定自体が無効なので実害がないため）。
const INITIAL_CREDITS = 50;
// 【正直な記録】「ゲーム開始時にプッシャー全体にコインが散らばっている」の初期枚数は
// 指示に明記がなかったための暫定値。50クレジット（プレイヤーの持ち球）とは別枠の
// 「最初から置いてある飾りのコイン」という解釈で実装した。要実機確認・調整。
const INITIAL_PILE_COUNT = 60;
let credits = INITIAL_CREDITS;
let gameOver = false;
const creditEl = document.getElementById('credit');
const gameOverOverlay = document.getElementById('gameOverOverlay');
function updateCreditUI() {
  creditEl.textContent = `クレジット: ${credits} 枚`;
}
function updateGameOverOverlay() {
  gameOverOverlay.classList.toggle('show', gameOver && productionMode);
}
function gainCredit(n = 1) {
  credits += n;
  updateCreditUI();
}
function spendCredit() {
  if (!productionMode) return true; // テストモードは消費・GameOver判定なし（投入し放題）
  if (gameOver || credits <= 0) return false;
  credits--;
  updateCreditUI();
  if (credits <= 0) {
    gameOver = true;
    updateGameOverOverlay();
  }
  return true;
}
function resetCredits() {
  credits = INITIAL_CREDITS;
  gameOver = false;
  updateCreditUI();
  updateGameOverOverlay();
}
function scatterInitialCoins() {
  for (let i = 0; i < INITIAL_PILE_COUNT; i++) {
    const x = clampSpawnX((Math.random() - 0.5) * FIELD_HALF_X * 2);
    const z = PUSHER_BACK_Z + 0.4 + Math.random() * 3.4; // プッシャーの可動域〜手前側に、得点ラインの手前で収まる範囲で散らす
    const y = 0.6 + Math.random() * 0.5; // 「最初から置いてある」見え方にするため低い高さから軽く落とす
    spawnCoin(x, y, z);
  }
}
updateCreditUI();
// ⚠️scatterInitialCoins()とupdateGameOverOverlay()の実際の初期呼び出しは、
// clock/productionMode等このファイル下部で定義される変数に依存するため、
// ファイル末尾（animate()の直前）でまとめて呼び出す（TDZ回避）。

// ---------- テスト/本番モード切替 ----------
// 本番モードでは投入手段をレーン（左右）のみに絞り、それ以外の投入ボタン・
// テスト用トリガー（JP発動/ルーレット発動）を非表示にする（削除ではなく非表示）。
// ⚠️デフォルトはテストモード。8/31の本番公開前に必ず true へ切り替えること。
let productionMode = false;
const btnModeToggle = document.getElementById('btnModeToggle');
const hintEl = document.getElementById('hint');
function applyModeUI() {
  document.body.classList.toggle('production-mode', productionMode);
  btnModeToggle.textContent = productionMode ? 'モード: 本番' : 'モード: テスト';
  btnModeToggle.classList.toggle('toggled', productionMode);
  hintEl.textContent = productionMode
    ? '左右のレーンからコインを投入（A＝左／L＝右／↑↓＝角度、スペース＝目押し）'
    : '画面をクリック / タップした位置にコインが落ちます（テストモード）';
  if (productionMode && autoInsert) {
    autoInsert = false;
    const btnAutoEl = document.getElementById('btnAuto');
    btnAutoEl.textContent = 'オート投入: OFF';
    btnAutoEl.classList.remove('toggled');
  }
  updateGameOverOverlay();
}
btnModeToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  productionMode = !productionMode;
  applyModeUI();
});
applyModeUI();

// ---------- スコア ----------
let score = 0;
const scoreEl = document.getElementById('score');
function updateScoreUI() {
  scoreEl.textContent = `GET: ${score} 枚`;
}

// ---------- リサイズ ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- メインループ ----------
const statsEl = document.getElementById('stats');
const clock = new THREE.Clock();
const FIXED_DT = 1 / 60;
let autoTimer = 0;
let fpsSmooth = 60;
// 倒れ防止ロックの水平度判定用に毎フレーム使い回すベクトル（GC負荷を避けるため使い回す）
const _upLocal = new CANNON.Vec3(0, 1, 0);
const _upWorld = new CANNON.Vec3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  fpsSmooth += (1 / Math.max(dt, 0.0001) - fpsSmooth) * 0.08;

  // プッシャーの伸縮（奥端はPUSHER_BACK_Zに固定したまま、長さだけをsin波で往復させる）
  const t = clock.elapsedTime;
  const halfLen = PUSHER_HALF_LEN_CENTER + PUSHER_HALF_LEN_AMP * Math.sin(t * PUSHER_SPEED);
  const halfLenRate = PUSHER_HALF_LEN_AMP * PUSHER_SPEED * Math.cos(t * PUSHER_SPEED);
  pusherShape.halfExtents.z = halfLen;
  pusherShape.updateConvexPolyhedronRepresentation();
  pusherShape.updateBoundingSphereRadius();
  pusherBody.updateBoundingRadius();
  pusherBody.aabbNeedsUpdate = true;
  // 先端（実際にコインを押す面）の移動速度は中心の移動速度の2倍になる
  // （奥端固定・中心=奥端+半長のため）。接触応答にはこちらを使う必要がある。
  pusherBody.velocity.set(0, 0, halfLenRate * 2);
  // cannon-esの運動学ボディは速度で位置を積分するため、微小なズレが蓄積しないよう
  // 毎フレーム「奥端固定」の正しい位置に直接引き戻す
  pusherBody.position.z = PUSHER_BACK_Z + halfLen;

  // 【(54)】プッシャー先端の穴アーチ：プッシャー本体に固定され、往復運動（伸縮）と
  // 一体で前後に動く。先端（実際にコインを押す面）のZは中心Z＋halfLen。
  // 開閉タイマーは持たない＝常時「通過可能」（実物の参考写真と同じ固定アーチ）
  pusherArchGroup.position.set(0, PUSHER_HALF_HEIGHT * 2 + 0.005, pusherBody.position.z + halfLen);

  if (autoInsert) {
    autoTimer += dt;
    if (autoTimer > 0.18) {
      autoTimer = 0;
      spawnCoin(clampSpawnX((Math.random() - 0.5) * FIELD_HALF_X * 2));
    }
  }

  // maxSubSteps を抑え、重い時ほど1フレームの再計算が増える「雪だるま現象」を防ぐ
  // （重い状況ではシミュレーション時間が実時間にわずかに遅れることを許容する）
  world.step(FIXED_DT, dt, 3);

  // このステップでプッシャーに直接触れているコイン／何かしらに接触しているコインの
  // IDを集める。（プッシャー中心からの距離で判定すると、プッシャーの可動範囲が広いため
  // 見えている山のほとんどが対象外になってしまっていた。直接接触の有無で判定することで、
  // 実際に押されているコインだけを正しく除外する。また「何にも接触していない＝
  // まだ自由落下中」のコインを強制スリープの対象から外すことで、投入直後（初速ゼロ）の
  // コインが空中で誤って凍結される不具合を防ぐ。）
  const pusherTouchingIds = new Set();
  const anyContactIds = new Set();
  const gateTouchingIds = new Set();
  for (const contact of world.contacts) {
    anyContactIds.add(contact.bi.id);
    anyContactIds.add(contact.bj.id);
    if (contact.bi === pusherBody) pusherTouchingIds.add(contact.bj.id);
    else if (contact.bj === pusherBody) pusherTouchingIds.add(contact.bi.id);
    if (contact.bi === gateBody) gateTouchingIds.add(contact.bj.id);
    else if (contact.bj === gateBody) gateTouchingIds.add(contact.bi.id);
  }
  // 「動いているもの」＝プッシャー本体＋プッシャーに直接触れているコイン、に
  // 触れているコインのID（＝間接的に押されている層）。この層まではスリープさせず、
  // 押す力が途中で途切れないようにする。
  const activeChainIds = new Set();
  for (const contact of world.contacts) {
    const biActive = contact.bi === pusherBody || pusherTouchingIds.has(contact.bi.id);
    const bjActive = contact.bj === pusherBody || pusherTouchingIds.has(contact.bj.id);
    if (biActive) activeChainIds.add(contact.bj.id);
    if (bjActive) activeChainIds.add(contact.bi.id);
  }
  const isReleasing = gateState !== 'up'; // warning〜closingの間はコインが坂を滑り下りる必要がある

  // メッシュをボディに同期 & 落下判定
  for (let i = coins.length - 1; i >= 0; i--) {
    const c = coins[i];
    c.mesh.position.copy(c.body.position);
    c.mesh.quaternion.copy(c.body.quaternion);

    // 何かに接触している間だけ「倒れる方向の回転禁止」を適用する。自由落下中
    // （プッシャーのヘリ・床のヘリから支えを失った瞬間など）は通常の物理挙動に戻し、
    // 自然にコロンと転がって見えるようにする（常時ロックだと不自然な平行移動落下になる）。
    // ただしrollUntilで転がり猶予中のコイン（レーン投入直後）はこのロックの対象外にし、
    // 着地してすぐ固まらず慣性で転がり続けて偶然の向きに倒れ込めるようにする。
    //
    // 【接触角度凍結バグの修正】以前は「接触した瞬間」に無条件でロックしていたため、
    // まだ転がり中・落下中のコインが一瞬だけ他のコインに触れただけで、その時の傾いた
    // 姿勢のままロックされ、以降ずっとその角度で静止して見える不具合があった
    // （テツさま実機報告）。ロック自体（倒れ防止）は必要な仕組みなので残しつつ、
    // 発動条件に「既にほぼ水平である」ことを追加し、水平から遠いコインは接触していても
    // まだロックせず、重力・摩擦で自然に水平へ収束するのを待ってからロックする。
    const stillRolling = c.rollUntil && t < c.rollUntil;
    if (!stillRolling) {
      if (anyContactIds.has(c.body.id)) {
        if (c.body.angularFactor.x !== 0 || c.body.angularFactor.z !== 0) {
          c.body.quaternion.vmult(_upLocal, _upWorld);
          if (_upWorld.y > FLAT_LOCK_UP_THRESHOLD) {
            c.body.angularFactor.set(0, 1, 0);
          }
        }
      } else if (c.body.angularFactor.x !== 1 || c.body.angularFactor.z !== 1) {
        c.body.angularFactor.set(1, 1, 1);
      }
    }
    const stillLanding = !stillRolling && (t - c.spawnT) < LANDING_GRACE;

    // 【震え対策・再設計（離れてから3秒後に徐々に）】
    // 従来は「動いているもの（プッシャー＋その活動チェーン）」から外れた瞬間、着地猶予
    // さえ過ぎていれば速度に関わらず即座にsleep()していた。これで震えは止まったが、
    // たまたま一瞬だけ他のコインに接触した（まだ落下・転動中の）コインまでその姿勢の
    // まま凍結され、空中や不自然な角度で静止して見える副作用が出た（テツさま実機報告）。
    // 離れてから3秒（IDLE_SLEEP_DELAY）は通常の物理のまま静かに様子を見て、そこから
    // 1秒（IDLE_SLEEP_RAMP）かけて減衰を徐々に強め、物理的に自然に減速しきったところで
    // 初めてsleep()する方式に変更した。位置・姿勢を直接いじらないため、途中経過も
    // 常に物理的に妥当な状態のまま推移する。
    const isActive =
      stillRolling ||
      stillLanding ||
      pusherTouchingIds.has(c.body.id) ||
      activeChainIds.has(c.body.id) ||
      (isReleasing && gateTouchingIds.has(c.body.id));

    // 【重要】睡眠→起床の遷移だけを理由に離脱タイマーをリセットしない。プッシャーが
    // 常時動き続けている影響で、連結した山全体にソルバー由来の微小な揺れが伝播し、
    // 眠っていたコインがごく僅かな接触更新で何度も起こされることがある。ここで毎回
    // タイマーをリセットしてしまうと、離れた場所のコインがいつまで経っても3秒間
    // 連続で「動いていない」と判定されず、減衰の強化（＝震えの収束）が始まらない
    // 状態に陥ることが無人テストで判明した（実際の速度が小さいままなのに震え続ける）。
    // タイマーは`isActive`（実際に押されている/転がっている等の正当な理由）の時だけ
    // リセットし、単なる睡眠状態のオン・オフでは継続してカウントする。万一まだ本当に
    // 動いている場合は、下のsleep()直前の速度チェックが安全弁として働く。
    const nowSleeping = c.body.sleepState === CANNON.Body.SLEEPING;

    if (isActive) {
      c.idleSince = null;
      if (stillRolling) {
        c.body.angularDamping = 0.05;
        c.body.linearDamping = 0.02;
      } else if (c.body.angularDamping !== 0.65 || c.body.linearDamping !== 0.05) {
        c.body.angularDamping = 0.65;
        c.body.linearDamping = 0.05;
      }
    } else {
      if (c.idleSince === null) c.idleSince = t;
      const idleElapsed = t - c.idleSince;
      if (idleElapsed < IDLE_SLEEP_DELAY) {
        if (c.body.angularDamping !== 0.65 || c.body.linearDamping !== 0.05) {
          c.body.angularDamping = 0.65;
          c.body.linearDamping = 0.05;
        }
      } else {
        const settleProgress = Math.min(1, (idleElapsed - IDLE_SLEEP_DELAY) / IDLE_SLEEP_RAMP);
        c.body.linearDamping = 0.05 + (SETTLE_LINEAR_DAMPING - 0.05) * settleProgress;
        c.body.angularDamping = 0.65 + (SETTLE_ANGULAR_DAMPING - 0.65) * settleProgress;
        if (
          !nowSleeping &&
          settleProgress >= 1 &&
          c.body.velocity.length() < FORCE_SLEEP_SPEED &&
          c.body.angularVelocity.length() < FORCE_SLEEP_SPEED * 1.5
        ) {
          c.body.sleep();
        }
      }
    }

    // 【すり抜け安全策】坂が完全に上がりきっている間（'up'/'warning'）は、コインの中心が
    // 得点ライン（EDGE_Z_FRONT）を越えることは本来ありえない（坂自体の形状が最大傾斜でも
    // その手前までしか届かない）。無人テストで調べたところ、原因はcannon-esのトンネリング
    // だけでなく、**坂の先端ぎりぎりに乗り上げたコインは、坂とまだ接触したままでも
    // コイン自体の半径分だけ中心が得点ラインの先へ出てしまう**ケースが主な漏れ経路だと
    // 判明した（「坂に触れているコインは対象外」という最初の実装は、この“接触したまま
    // 中心だけ越えている”コインを誤って見逃していた）。接触の有無に関わらず、得点ラインを
    // 越えたコインは問答無用で坂の手前へ押し戻す、という単純で堅牢なルールに修正した。
    if ((gateState === 'up' || gateState === 'warning') && c.body.position.z > EDGE_Z_FRONT) {
      c.body.position.z = RAMP_BACK_Z - 0.1;
      c.body.velocity.z = Math.min(c.body.velocity.z, 0);
      c.body.wakeUp();
    }

    if (c.body.position.z > EDGE_Z_FRONT) {
      score++;
      updateScoreUI();
      gainCredit();
      // 即座に消さず、画面手前へ落ちていく演出のためfallingCoinsへ引き継ぐ
      // （cannon-esワールドからは外すので、密集した山の物理コストには影響しない）
      fallingCoins.push({
        mesh: c.mesh,
        vx: c.body.velocity.x,
        vy: c.body.velocity.y,
        vz: Math.max(c.body.velocity.z, 1.2),
        spinX: (Math.random() - 0.5) * 6,
        spinZ: (Math.random() - 0.5) * 6,
      });
      world.removeBody(c.body);
      coins.splice(i, 1);
    } else if (c.body.position.y < -6) {
      scene.remove(c.mesh);
      world.removeBody(c.body);
      coins.splice(i, 1);
    } else if (
      !c.archPassed &&
      c.body.position.y > PUSHER_ARCH_Y_MIN && c.body.position.y < PUSHER_ARCH_Y_MAX &&
      Math.hypot(c.body.position.x - pusherArchGroup.position.x, c.body.position.z - pusherArchGroup.position.z) < PUSHER_ARCH_RADIUS
    ) {
      // 【(54)、2026-08-25追加指示】プッシャー先端の穴アーチを実際に通ったコイン（B方式）。
      // 吸い込み演出はせず、コインは物理ワールドに残したまま床へ普通に落ちる。
      // 同じコインを同じフレーム跨ぎで何度も数えないよう、通過済みフラグを立てる。
      // アーチの左右からこぼれ落ちたコインは通常得点にはなるが、このカウントには入らない。
      c.archPassed = true;
      holeCount++;
      if (holeCount >= HOLE_GOAL) {
        holeCount = 0;
        // 【(54)Step7】ポーカー発動に差し替え。既に進行中（idle以外）なら新規発動はせず、
        // holeCountのリセットのみ行う（次のサイクルから通常通りカウントする実装判断）
        if (pokerState === 'idle') startPoker();
      }
    }
  }

  // ボールの同期＆落下判定（得点にはならないが、同じ演出でトレイへ落ちていく）
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    b.mesh.position.copy(b.body.position);
    b.mesh.quaternion.copy(b.body.quaternion);

    if (b.body.position.z > EDGE_Z_FRONT) {
      // ボールが得点ラインまで転がりきった＝ゲートを乗り越えた合図。せき止めていた
      // コインを解放するシーケンスを開始する。
      triggerGateRelease();
      fallingCoins.push({
        mesh: b.mesh,
        vx: b.body.velocity.x,
        vy: b.body.velocity.y,
        vz: Math.max(b.body.velocity.z, 1.2),
        spinX: (Math.random() - 0.5) * 6,
        spinZ: (Math.random() - 0.5) * 6,
      });
      world.removeBody(b.body);
      balls.splice(i, 1);
    } else if (b.body.position.y < -6) {
      scene.remove(b.mesh);
      world.removeBody(b.body);
      balls.splice(i, 1);
    }
  }

  // 宝石の同期＆落下判定（ボールと同じく得点ラインまで転がりきったらストッパーを開放。
  // あわせて種類を収集済みセットに記録し、12種類そろったらジャックポットスロットを起動する）
  for (let i = gems.length - 1; i >= 0; i--) {
    const g = gems[i];
    // 【2026-08-20】転がり速度の抑制：これまでlinearDamping/angularDampingという
    // 「抵抗」の調整を繰り返してきたが、それでも「相変わらず転がり落ちるさまが早い」との
    // 報告が続いた。当たり判定がCANNON.Sphere（幾何学的に転がり抵抗がほぼゼロな形状）で
    // ある以上、抵抗係数をいくら上げても根本解決しにくいと判断し、速度そのものに上限を
    // 課すガバナー方式に切り替えた。角速度は v=ωr の関係を保つ上限にすることで、上限に
    // 達しても「滑り」に転じず自然な転がりの見た目を保つ。
    // 【追加修正】この上限を常時かけていたところ「落ちるときの速さまで遅くなった」との
    // 指摘を受け、g.landed（spawnGemでcollideイベントにより一度でも何かに触れたら true）
    // の間だけ適用するよう変更。スポーンから着地するまでの自由落下は無加工のまま。
    if (g.landed) {
      const gemSpeed = g.body.velocity.length();
      if (gemSpeed > GEM_MAX_SPEED) {
        g.body.velocity.scale(GEM_MAX_SPEED / gemSpeed, g.body.velocity);
      }
      const gemAngSpeed = g.body.angularVelocity.length();
      if (gemAngSpeed > GEM_MAX_ANGULAR_SPEED) {
        g.body.angularVelocity.scale(GEM_MAX_ANGULAR_SPEED / gemAngSpeed, g.body.angularVelocity);
      }
    }
    g.mesh.position.copy(g.body.position);
    g.mesh.quaternion.copy(g.body.quaternion);
    // ランダムな間隔で、2〜3箇所が同時にランダムな位置・ランダムなサイズで
    // フェードイン→フェードアウトする煌めきバースト。sin波の半周期を使い、
    // 通常時は全スプライトopacity=0のまま静かに待機する
    if (t >= g.glint.nextAt) {
      const dur = 0.5;
      const local = t - g.glint.nextAt;
      if (local < dur) {
        if (!g.glint.burstActive) {
          g.glint.burstActive = true;
          // 【2026-08-20 テツさま指摘】「動いている最中は少し派手目に、止まっているときは
          // 控えめに」。バースト開始時点の実速度（線速度＋角速度×半径の概算面速度）で
          // 「動いている」かを判定し、動いている間はより多くの粒が・より大きく・より
          // 高頻度で光るようにする。静止中は従来（㊿〜追加修正3）の控えめな設定のまま。
          const gemMoveSpeed = g.body.velocity.length() + g.body.angularVelocity.length() * GEM_RADIUS;
          const moving = gemMoveSpeed > GLINT_MOTION_SPEED_THRESHOLD;
          const activeN = moving ? 3 : (2 + Math.floor(Math.random() * 2)); // 動作中は常に3、静止中は2〜3
          g.glint.activeN = activeN;
          g.glint.moving = moving;
          for (let k = 0; k < g.glint.sprites.length; k++) {
            if (k < activeN) {
              const a = Math.random() * Math.PI * 2;
              const rr = GEM_RADIUS * (0.3 + Math.random() * 0.6);
              g.glint.offsets[k].set(Math.cos(a) * rr, (Math.random() - 0.5) * GEM_RADIUS * 0.8, Math.sin(a) * rr);
              const sizeMul = moving ? (0.22 + Math.random() * 0.18) : (0.13 + Math.random() * 0.13);
              g.glint.sprites[k].scale.setScalar(GEM_RADIUS * 2.6 * sizeMul);
            }
          }
        }
        const op = Math.sin((local / dur) * Math.PI);
        for (let k = 0; k < g.glint.sprites.length; k++) {
          if (k < g.glint.activeN) {
            g.glint.sprites[k].position.copy(g.body.position).add(g.glint.offsets[k]);
            g.glint.sprites[k].material.opacity = op;
          } else {
            g.glint.sprites[k].material.opacity = 0;
          }
        }
      } else {
        for (const s of g.glint.sprites) s.material.opacity = 0;
        g.glint.burstActive = false;
        // 動作中は次のバーストまでの間隔を短くして、より派手に光り続けるようにする
        g.glint.nextAt = t + (g.glint.moving ? (0.15 + Math.random() * 0.35) : (0.6 + Math.random() * 1.2));
      }
    }

    // 【㉚で近似ルールを撤廃・ボールと同じ厳密な判定に統一】
    // ㉘時点では宝石が坂を登り切れず「坂に接触し減速したら成功」という近似ルールを
    // 使っていたが、これはgateState（ストッパーが実際に開いているか）を見ておらず、
    // ストッパーが閉まったまま（'up'）でも宝石が消えてしまい、「閉じて見えるのに
    // すり抜けて落ちている」ように見える不具合の原因になっていた（テツさま実機報告）。
    // ㉚では近似ルールを完全に撤廃し、ボールと全く同じ「EDGE_Z_FRONTに実際に到達」
    // 判定に統一した。これにより閉まっているストッパーの前で宝石が消えることは
    // 原理的になくなる（詳細・検証結果はspec.md参照。宝石を大型化して坂専用の
    // 摩擦を強めても、単発の勢いだけで登り切れる確率は無人テストでは低いままだった
    // ため、実際の登坂は「山の圧力で押され続けた末に登り切る」「解放時に後ろの
    // コインの奔流に押されて一緒に渡る」といった、実プレイでの持続的な圧力に
    // 期待する設計になっている＝正直な記録として次回相談したい）。
    if (g.body.position.z > EDGE_Z_FRONT) {
      triggerGateRelease(GEM_GATE_OPEN_DURATION);
      if (!collectedGems.has(g.typeIndex)) {
        collectedGems.add(g.typeIndex);
        updateGemTrackerUI();
        // 【Step3】誕生石を1個入手するたびコインタワーが1段育つ（JPスロットの目押しが緩くなる）
        jpTowerStage = Math.min(jpTowerStage + 1, JP_TOWER_MAX_STAGE);
        updateJpTowerVisual();
        if (collectedGems.size >= GEM_TYPES.length && jackpotState === 'idle') {
          startJackpot();
        }
      }
      fallingCoins.push({
        mesh: g.mesh,
        vx: g.body.velocity.x,
        vy: g.body.velocity.y,
        vz: Math.max(g.body.velocity.z, 1.2),
        spinX: (Math.random() - 0.5) * 8,
        spinZ: (Math.random() - 0.5) * 8,
      });
      for (const s of g.glint.sprites) scene.remove(s);
      world.removeBody(g.body);
      gems.splice(i, 1);
    } else if (g.body.position.y < -6) {
      scene.remove(g.mesh);
      for (const s of g.glint.sprites) scene.remove(s);
      world.removeBody(g.body);
      gems.splice(i, 1);
    }
  }

  // せき止めゲートの状態遷移（上がっている→予告点滅→下がる→解放中→また上がる）
  gateTimer += dt;
  if (gateState === 'warning') {
    const pulse = 0.5 + 0.5 * Math.sin(gateTimer * 22);
    gateMat.emissive.setRGB(pulse * 0.9, pulse * 0.6, 0);
    if (gateTimer >= GATE_WARNING_DURATION) {
      gateState = 'opening';
      gateTimer = 0;
    }
  } else if (gateState === 'opening') {
    const frac = 1 - Math.min(gateTimer / GATE_MOVE_DURATION, 1);
    setGateFraction(frac, dt);
    if (gateTimer >= GATE_MOVE_DURATION) {
      gateState = 'open';
      gateTimer = 0;
      gateMat.emissive.setRGB(0, 0, 0);
      // 動きが止まったら速度も明示的に0へ戻す（そのままだと最後のフレームの
      // 速度が残り続け、静止しているはずのゲートが動いていると誤認識される）
      gateBody.velocity.set(0, 0, 0);
      gateBody.angularVelocity.set(0, 0, 0);
    }
  } else if (gateState === 'open') {
    if (gateTimer >= gateOpenDuration) {
      gateState = 'closing';
      gateTimer = 0;
    }
  } else if (gateState === 'closing') {
    const frac = Math.min(gateTimer / GATE_MOVE_DURATION, 1);
    setGateFraction(frac, dt);
    if (gateTimer >= GATE_MOVE_DURATION) {
      gateState = 'up';
      gateTimer = 0;
      gateBody.velocity.set(0, 0, 0);
      gateBody.angularVelocity.set(0, 0, 0);
    }
  }

  // GET演出：画面手前へ落ちていくコインを簡易な放物運動で動かす（物理ワールド外）
  for (let i = fallingCoins.length - 1; i >= 0; i--) {
    const f = fallingCoins[i];
    f.vy += world.gravity.y * dt;
    f.mesh.position.x += f.vx * dt;
    f.mesh.position.y += f.vy * dt;
    f.mesh.position.z += f.vz * dt;
    f.mesh.rotateX(f.spinX * dt);
    f.mesh.rotateZ(f.spinZ * dt);

    if (f.mesh.position.y < -3) {
      scene.remove(f.mesh);
      fallingCoins.splice(i, 1);
    }
  }

  // ルーレットの状態遷移：回転中（目押し受付中）→結果表示→報酬コインを山へ降らせる
  if (rouletteState === 'playing') {
    rouletteCurrentAngle += ROULETTE_SPIN_SPEED * dt;
    rouletteCanvas.style.transform = `rotate(${rouletteCurrentAngle}rad)`;
    rouletteAimT += dt;
    // 【正直な記録】放置し続けると永久に待たされるため、タイムアウトでその時点の
    // 回転位置により自動判定する安全策を入れている（JPスロット側と同じ考え方）
    if (rouletteAimT >= ROULETTE_AIM_TIMEOUT) stopRouletteAim();
  } else if (rouletteState === 'result') {
    rouletteTimer += dt;
    if (rouletteTimer >= 1.6) {
      rouletteState = 'idle';
      rouletteOverlayEl.classList.remove('show');
      // 【追加】プッシャーへも降らせつつ、シャンパンタワーへも同じ枚数ぶん注ぐ（両方同時）
      rainQueueCount += rouletteReward;
      rainTimer = 0;
      towerPourQueueCount += rouletteReward;
      towerPourTimer = 0;
      // 宝石枠が当たった場合は、実際に宝石を1個生成してプッシャーへ落とす
      if (rouletteGrantsGem) spawnGem();
    }
  }

  // ジャックポットスロットの状態遷移：3リール回転・1本ずつ目押し→結果表示→（成功時のみ）
  // 報酬コインを山へ降らせる＆コインタワー崩壊→収集リセット
  if (jackpotState === 'playing') {
    const speed = jpReelSpeed();
    for (let i = 0; i < JP_REEL_COUNT; i++) {
      if (!jpReelSpinning[i]) continue;
      jpReelPhase[i] = (jpReelPhase[i] + speed * dt) % JP_REEL_LEN;
      updateReelTransform(i);
    }
    // 【正直な記録】放置し続けると永久に待たされるため、タイムアウトでその時点の
    // 位置により自動的にリールを止める安全策を入れている（旧・ゾーン方式と同じ考え方）
    jpActiveReelTimer += dt;
    if (jpActiveReelTimer >= JP_REEL_TIMEOUT) {
      stopActiveReel();
    }
  } else if (jackpotState === 'result') {
    jackpotTimer += dt;
    if (jackpotTimer >= 2.2) {
      jackpotState = 'idle';
      jackpotOverlayEl.classList.remove('show');
      // ジャックポット終了後はまた0から宝石を集め始める（テツさま指示。成功/失敗どちらでも
      // リセットする一方、コインタワーの段階は失敗時には残る＝下記の分岐参照）
      collectedGems.clear();
      updateGemTrackerUI();
      if (jackpotSuccess) {
        // ルーレットの報酬消化と同時に走っていても取りこぼさないよう加算する
        rainQueueCount += jackpotReward;
        rainTimer = 0;
        jpTowerStage = 0;
        triggerJpTowerCollapse();
        // 【(51)】スロット演出が終わったところで、続けてコインレールの解放を始める
        // 【Step3で判断】ジャックポット失敗時はこの二重報酬（コインレール解放）は発生させない
        // （外れた時の「何も得られない」感を保つため。テツさまへの明示確認はしていない判断）
        if (towerFillTotal > 0 && towerReleaseState === 'idle') {
          towerReleaseState = 'cascading';
          towerReleaseTimer = 0;
          towerReleaseCascadeStartTotal = towerFillTotal;
        }
      } else {
        jpTowerStage = Math.min(jpTowerStage + 1, JP_TOWER_MAX_STAGE);
      }
      updateJpTowerVisual();
    }
  }

  // コインタワー崩壊のきらめきパーティクル更新（Step3）
  for (let i = jpBurstParticles.length - 1; i >= 0; i--) {
    const p = jpBurstParticles[i];
    p.life += dt;
    p.vel.y += world.gravity.y * dt * 0.3;
    p.sprite.position.addScaledVector(p.vel, dt);
    const tLife = p.life / p.maxLife;
    p.sprite.material.opacity = Math.max(0, 1 - tLife);
    if (p.life >= p.maxLife) {
      scene.remove(p.sprite);
      p.sprite.material.dispose();
      jpBurstParticles.splice(i, 1);
    }
  }

  // 【(51)】ルーレット報酬をシャンパンタワー最上段へ1枚ずつ注ぐキュー処理
  if (towerPourQueueCount > 0) {
    towerPourTimer += dt;
    if (towerPourTimer >= TOWER_POUR_INTERVAL) {
      towerPourTimer = 0;
      towerPourQueueCount--;
      towerFillTotal = Math.min(TOWER_CAP, towerFillTotal + 1);
      updateTowerFillVisual();
    }
  }

  // 【2026-08-20】コインサイロの解放：中身の高さが一気に減っていく（cascading）演出の後、
  // 空になったところで溜め量ぶんをGET枚数へ直接加算する（pouring）。当初（タワー版）は
  // プッシャーへ実体コインとして投下していたが、テツさま指示により「解放＝そのまま
  // GET枚数に乗る」方式に変更（プッシャーで再度押し出す手間をなくし、報酬感を直接的にした）
  if (towerReleaseState === 'cascading') {
    towerReleaseTimer += dt;
    const drainFrac = Math.min(1, towerReleaseTimer / RAIL_DRAIN_DURATION);
    towerFillTotal = Math.max(0, towerReleaseCascadeStartTotal * (1 - drainFrac));
    updateTowerFillVisual();
    if (drainFrac >= 1) {
      towerReleaseState = 'pouring';
      towerReleaseTimer = 0;
      towerReleasePourQueueCount = towerReleaseCascadeStartTotal;
      towerFillTotal = 0;
      towerReleasePourTimer = 0;
    }
  } else if (towerReleaseState === 'pouring') {
    if (towerReleasePourQueueCount > 0) {
      towerReleasePourTimer += dt;
      if (towerReleasePourTimer >= TOWER_RELEASE_POUR_INTERVAL) {
        towerReleasePourTimer = 0;
        towerReleasePourQueueCount--;
        // 1枚ずつテンポよくGET枚数へ加算する（プッシャーへは投下しない）
        score++;
        updateScoreUI();
        gainCredit();
      }
    } else {
      towerReleaseState = 'idle';
    }
  }

  if (rainQueueCount > 0) {
    rainTimer += dt;
    if (rainTimer >= RAIN_INTERVAL) {
      rainTimer = 0;
      rainQueueCount--;
      const rx = clampSpawnX((Math.random() - 0.5) * FIELD_HALF_X * 2);
      const rz = -1.2 + Math.random() * 3.4;
      spawnCoin(rx, SPAWN_Y + 1.8 + Math.random() * 0.6, rz);
    }
  }

  // レーン投入：レールの上を転がるコインを更新し、終端でその時点の速度・角速度・姿勢を
  // 引き継いで物理ワールドへ渡す（着地後も慣性で転がり続け、倒れる向きは物理まかせにする）
  for (let i = rollingCoins.length - 1; i >= 0; i--) {
    const r = rollingCoins[i];
    // カーブは毎フレーム railPoints() から取り直す。投入後にスライダーで角度を変えた場合、
    // 移動中のコインも新しいカーブに追従するようにするため（固定値だと反映されなかった）。
    const { curve } = railPoints(r.side);
    const curveLen = curve.getLength();
    r.t = Math.min(r.t + dt / RAIL_DURATION, 1);
    // getPointAt/getTangentAtは弧長パラメータ化されているため、ベジェ曲線でも
    // カーブに沿って等速で進んでいるように見える（生のgetPointAtは等速にならない）。
    // RAIL_COIN_LIFTぶん上にオフセットし、トラックの上に乗って見えるようにする
    // （物理ワールドへの引き継ぎ位置`end`は下記の通りオフセットしない生の値を使う）
    r.mesh.position.copy(curve.getPointAt(r.t)).y += RAIL_COIN_LIFT;
    const travelThisFrame = curveLen * (dt / RAIL_DURATION);
    // 進んだ距離ぶんだけ自身のローカルY軸（=見た目上の転がる軸）まわりに回転させ、
    // 実際に転がっているように見せる（転がり速度 = 距離 / 半径）。符号は進行方向に
    // よって逆になる（右レーンと左レーンでX方向の進む向きが逆のため）。
    r.mesh.rotateY(r.spinSign * (travelThisFrame / COIN_RADIUS));

    if (r.t >= 1) {
      scene.remove(r.mesh);
      rollingCoins.splice(i, 1);
      const avgSpeed = curveLen / RAIL_DURATION;
      // 終端の初速方向は、カーブが曲がっている分を反映するため直線ではなく
      // 終端付近の接線方向（getTangentAt）を使う。
      const tangent = curve.getTangentAt(1);
      const end = curve.getPointAt(1);
      const initialVelocity = new CANNON.Vec3(tangent.x * avgSpeed, tangent.y * avgSpeed, tangent.z * avgSpeed);
      // レールと同じ「立った」姿勢のまま引き継ぐ（少しランダムな傾きを加える）
      const standingQuat = new CANNON.Quaternion();
      standingQuat.setFromEuler(Math.PI / 2 + (Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, 0);
      const rollAngularSpeed = r.spinSign * (avgSpeed / COIN_RADIUS);
      const initialAngularVelocity = new CANNON.Vec3(0, 0, rollAngularSpeed);
      spawnCoin(
        end.x, end.y, end.z,
        initialVelocity, standingQuat, initialAngularVelocity,
        clock.elapsedTime + 4.0 // この時刻まで転がり続けられる（倒れ防止ロックの対象外）
      );
    }
  }

  // メッシュも同じ長さ・位置に伸縮させる（ベースジオメトリの奥行きは1なのでscale.zがそのまま長さになる）
  pusherMesh.scale.z = halfLen * 2;
  pusherMesh.position.copy(pusherBody.position);
  pusherMesh.quaternion.copy(pusherBody.quaternion);

  updatePoker(dt);

  controls.update();
  renderer.render(scene, camera);

  statsEl.innerHTML = `FPS: ${fpsSmooth.toFixed(0)}<br>コイン数: ${coins.length} / ${MAX_COINS}<br>ホール: ${holeCount} / ${HOLE_GOAL}`;
}

// クレジット制の初期化（GameOverオーバーレイ判定・初期コイン散布）。
// clock/productionMode等このファイル内で後から定義される変数に依存するため、ここで呼ぶ。
updateGameOverOverlay();
scatterInitialCoins();

animate();
