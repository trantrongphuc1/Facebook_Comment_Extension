const { sql, getPool, withTransaction } = require('../db');

function mapJobRow(row) {
  return {
    jobId: row.JobId,
    templateId: row.TemplateId,
    templateTitle: row.TemplateTitle,
    targetPostUrl: row.TargetPostUrl,
    status: Number(row.Status),
    lastMessage: row.LastMessage,
    scheduledAt: row.ScheduledAt,
    startedAt: row.StartedAt,
    finishedAt: row.FinishedAt,
    createdAt: row.CreatedAt,
    updatedAt: row.UpdatedAt
  };
}

async function listJobs() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT
      j.JobId,
      j.TemplateId,
      t.Title AS TemplateTitle,
      j.TargetPostUrl,
      j.Status,
      j.LastMessage,
      j.ScheduledAt,
      j.StartedAt,
      j.FinishedAt,
      j.CreatedAt,
      j.UpdatedAt
    FROM dbo.CommentJobs j
    INNER JOIN dbo.CommentTemplates t ON t.TemplateId = j.TemplateId
    ORDER BY j.CreatedAt DESC;
  `);

  return result.recordset.map(mapJobRow);
}

async function createJobs({ templateId, targetPostUrls, scheduledAt }) {
  const urls = Array.isArray(targetPostUrls) ? targetPostUrls : [];
  if (!urls.length) {
    throw new Error('TargetPostUrls is empty');
  }

  return withTransaction(async (transaction) => {
    const created = [];

    for (const rawUrl of urls) {
      const targetPostUrl = String(rawUrl || '').trim();
      if (!targetPostUrl) {
        continue;
      }

      const insertResult = await new sql.Request(transaction)
        .input('templateId', sql.UniqueIdentifier, templateId)
        .input('targetPostUrl', sql.NVarChar(2048), targetPostUrl)
        .input('scheduledAt', sql.DateTime2, scheduledAt || null)
        .query(`
          INSERT INTO dbo.CommentJobs (TemplateId, TargetPostUrl, ScheduledAt)
          OUTPUT inserted.JobId
          VALUES (@templateId, @targetPostUrl, @scheduledAt);
        `);

      created.push(insertResult.recordset[0].JobId);
    }

    return created;
  });
}

async function updateJobStatus(jobId, { status, message }) {
  const pool = await getPool();
  const fields = [];
  const request = pool.request().input('jobId', sql.UniqueIdentifier, jobId);

  if (typeof status === 'number') {
    fields.push('Status = @status');
    request.input('status', sql.TinyInt, status);
  }

  if (message !== undefined) {
    fields.push('LastMessage = @message');
    request.input('message', sql.NVarChar(sql.MAX), message);
  }

  if (!fields.length) {
    return null;
  }

  fields.push('UpdatedAt = SYSUTCDATETIME()');
  await request.query(`
    UPDATE dbo.CommentJobs
    SET ${fields.join(', ')}
    WHERE JobId = @jobId;
  `);
  return true;
}

async function addJobLog(jobId, level, message) {
  const pool = await getPool();
  await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('level', sql.NVarChar(20), level)
    .input('message', sql.NVarChar(sql.MAX), message)
    .query(`
      INSERT INTO dbo.CommentJobLogs (JobId, Level, Message)
      VALUES (@jobId, @level, @message);
    `);
}

module.exports = {
  listJobs,
  createJobs,
  updateJobStatus,
  addJobLog
};