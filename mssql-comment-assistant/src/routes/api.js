const express = require('express');
const multer = require('multer');
const {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getTemplateImage
} = require('../services/templateService');
const {
  listJobs,
  createJobs,
  updateJobStatus,
  addJobLog
} = require('../services/jobService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

function toBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizeTemplatePayload(body) {
  return {
    title: String(body.title || '').trim(),
    body: String(body.body || '').trim(),
    targetPostUrl: String(body.targetPostUrl || '').trim(),
    notes: String(body.notes || '').trim(),
    isActive: toBool(body.isActive ?? true),
    replaceImages: toBool(body.replaceImages ?? false)
  };
}

function parseUploadedImages(files) {
  return (files || []).map((file, index) => ({
    fileName: file.originalname,
    mimeType: file.mimetype,
    content: file.buffer,
    sortOrder: index
  }));
}

function validateTemplate(payload) {
  if (!payload.title) {
    return 'Title is required';
  }
  if (!payload.body) {
    return 'Body is required';
  }
  return null;
}

function parseTargetUrls(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }

  return String(value || '')
    .split(/\r?\n|,/) 
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildTemplateRouter() {
  const router = express.Router();

  router.get('/', async (_req, res, next) => {
    try {
      const templates = await listTemplates();
      res.json({ ok: true, data: templates });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:templateId', async (req, res, next) => {
    try {
      const template = await getTemplateById(req.params.templateId);
      if (!template) {
        res.status(404).json({ ok: false, message: 'Template not found' });
        return;
      }
      res.json({ ok: true, data: template });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', upload.array('images', 12), async (req, res, next) => {
    try {
      const payload = normalizeTemplatePayload(req.body);
      const validationError = validateTemplate(payload);
      if (validationError) {
        res.status(400).json({ ok: false, message: validationError });
        return;
      }

      const created = await createTemplate({
        ...payload,
        images: parseUploadedImages(req.files)
      });
      res.status(201).json({ ok: true, data: created });
    } catch (error) {
      next(error);
    }
  });

  router.put('/:templateId', upload.array('images', 12), async (req, res, next) => {
    try {
      const payload = normalizeTemplatePayload(req.body);
      const validationError = validateTemplate(payload);
      if (validationError) {
        res.status(400).json({ ok: false, message: validationError });
        return;
      }

      const updated = await updateTemplate(req.params.templateId, {
        ...payload,
        images: parseUploadedImages(req.files),
        replaceImages: payload.replaceImages
      });

      if (!updated) {
        res.status(404).json({ ok: false, message: 'Template not found' });
        return;
      }

      res.json({ ok: true, data: updated });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:templateId', async (req, res, next) => {
    try {
      await deleteTemplate(req.params.templateId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:templateId/images/:imageId', async (req, res, next) => {
    try {
      const image = await getTemplateImage(req.params.templateId, req.params.imageId);
      if (!image) {
        res.status(404).json({ ok: false, message: 'Image not found' });
        return;
      }

      res.setHeader('Content-Type', image.MimeType);
      res.setHeader('Content-Disposition', `inline; filename="${image.FileName}"`);
      res.send(image.Content);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function buildJobRouter() {
  const router = express.Router();

  router.get('/', async (_req, res, next) => {
    try {
      const jobs = await listJobs();
      res.json({ ok: true, data: jobs });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const templateId = String(req.body.templateId || '').trim();
      const targetPostUrls = parseTargetUrls(req.body.targetPostUrls || req.body.targetPostUrl);
      const scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;

      if (!templateId) {
        res.status(400).json({ ok: false, message: 'TemplateId is required' });
        return;
      }

      if (!targetPostUrls.length) {
        res.status(400).json({ ok: false, message: 'Target post URL is required' });
        return;
      }

      const createdIds = await createJobs({ templateId, targetPostUrls, scheduledAt });
      res.status(201).json({ ok: true, data: { createdIds } });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:jobId/status', async (req, res, next) => {
    try {
      const status = Number(req.body.status);
      const message = String(req.body.message || '').trim();
      if (!Number.isFinite(status)) {
        res.status(400).json({ ok: false, message: 'Status is required' });
        return;
      }

      await updateJobStatus(req.params.jobId, { status, message });
      if (message) {
        await addJobLog(req.params.jobId, 'info', message);
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = function buildApiRouter() {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, status: 'up' });
  });

  router.use('/templates', buildTemplateRouter());
  router.use('/jobs', buildJobRouter());

  return router;
};