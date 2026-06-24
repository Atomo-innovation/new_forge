const serverlessLifecycle = require('../lib/serverless-lifecycle');

let app;

async function loadApp() {
  if (!app) {
    app = require('../server');
  }
  return app;
}

module.exports = async (req, res) => {
  try {
    await serverlessLifecycle.prepareForRequest();
    const expressApp = await loadApp();

    await new Promise((resolve, reject) => {
      res.on('finish', () => {
        serverlessLifecycle.finalizeAfterRequest().then(resolve).catch(reject);
      });
      res.on('error', reject);
      expressApp(req, res);
    });
  } catch (err) {
    console.error('[Vercel] handler failed:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: 'Serverless function failed.',
        detail: err.message,
      }));
    }
  }
};
