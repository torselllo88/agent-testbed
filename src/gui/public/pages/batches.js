import { app } from "../shared.js";

export function renderBatches() {
  app.innerHTML = `
    <div class="page-header"><h1>Batches</h1></div>
    <div class="card empty-state">
      <p>Batch experiments (N repetitions × parameter variations) arrive in the next step.</p>
    </div>`;
}
