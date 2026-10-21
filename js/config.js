// Firebase コンソール →「プロジェクトの設定」→「マイアプリ」に表示される値を貼り付けてください。
// apiKey が空のままだと「デモモード」（このブラウザだけに保存）で動きます。
// ※ この値は公開されても問題ない設計です。データの保護は firestore.rules が担います。
export const firebaseConfig = {
  apiKey: "AIzaSyA2cBbupMjne092R0H__bkuJhCJ-LdSTOc",
  authDomain: "nexora-876f5.firebaseapp.com",
  projectId: "nexora-876f5",
  storageBucket: "nexora-876f5.firebasestorage.app",
  messagingSenderId: "506823278056",
  appId: "1:506823278056:web:15dbdf862696c922b9f85d",
};

// 任意：自分のメールアドレスを入れると、それ以外のアカウントはログイン直後に締め出します。
// （本当の守りは firestore.rules。こちらは画面上の案内用です）
export const ALLOWED_EMAIL = "";
