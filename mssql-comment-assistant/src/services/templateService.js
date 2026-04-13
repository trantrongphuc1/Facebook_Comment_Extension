const { sql, getPool, withTransaction } = require('../db');

function mapTemplateRow(row) {
  return {
    templateId: row.TemplateId,
    title: row.Title,
    body: row.Body,
    targetPostUrl: row.TargetPostUrl,
    notes: row.Notes,
    isActive: Boolean(row.IsActive),
    imageCount: Number(row.ImageCount || 0),
    createdAt: row.CreatedAt,
    updatedAt: row.UpdatedAt
  };
}

function mapImageRow(row) {
  return {
    imageId: row.ImageId,
    templateId: row.TemplateId,
    fileName: row.FileName,
    mimeType: row.MimeType,
    sortOrder: Number(row.SortOrder || 0),
    createdAt: row.CreatedAt
  };
}

async function listTemplates() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT
      t.TemplateId,
      t.Title,
      t.Body,
      t.TargetPostUrl,
      t.Notes,
      t.IsActive,
      t.CreatedAt,
      t.UpdatedAt,
      COUNT(i.ImageId) AS ImageCount
    FROM dbo.CommentTemplates t
    LEFT JOIN dbo.TemplateImages i ON i.TemplateId = t.TemplateId
    GROUP BY t.TemplateId, t.Title, t.Body, t.TargetPostUrl, t.Notes, t.IsActive, t.CreatedAt, t.UpdatedAt
    ORDER BY t.CreatedAt DESC;
  `);

  return result.recordset.map(mapTemplateRow);
}

async function getTemplateById(templateId) {
  const pool = await getPool();
  const templateResult = await pool.request()
    .input('templateId', sql.UniqueIdentifier, templateId)
    .query(`
      SELECT TOP 1
        TemplateId,
        Title,
        Body,
        TargetPostUrl,
        Notes,
        IsActive,
        CreatedAt,
        UpdatedAt
      FROM dbo.CommentTemplates
      WHERE TemplateId = @templateId;
    `);

  const template = templateResult.recordset[0];
  if (!template) {
    return null;
  }

  const imageResult = await pool.request()
    .input('templateId', sql.UniqueIdentifier, templateId)
    .query(`
      SELECT
        ImageId,
        TemplateId,
        FileName,
        MimeType,
        Content,
        SortOrder,
        CreatedAt
      FROM dbo.TemplateImages
      WHERE TemplateId = @templateId
      ORDER BY SortOrder ASC, CreatedAt ASC;
    `);

  return {
    ...mapTemplateRow({ ...template, ImageCount: imageResult.recordset.length }),
    images: imageResult.recordset.map(({ Content, ...row }) => mapImageRow(row))
  };
}

async function createTemplate({ title, body, targetPostUrl, notes, isActive, images }) {
  return withTransaction(async (transaction) => {
    const templateRequest = new sql.Request(transaction);
    const insertResult = await templateRequest
      .input('title', sql.NVarChar(200), title)
      .input('body', sql.NVarChar(sql.MAX), body)
      .input('targetPostUrl', sql.NVarChar(2048), targetPostUrl || null)
      .input('notes', sql.NVarChar(1000), notes || null)
      .input('isActive', sql.Bit, isActive ? 1 : 0)
      .query(`
        INSERT INTO dbo.CommentTemplates (Title, Body, TargetPostUrl, Notes, IsActive)
        OUTPUT inserted.TemplateId
        VALUES (@title, @body, @targetPostUrl, @notes, @isActive);
      `);

    const templateId = insertResult.recordset[0].TemplateId;
    const safeImages = Array.isArray(images) ? images : [];

    for (let i = 0; i < safeImages.length; i += 1) {
      const image = safeImages[i];
      await new sql.Request(transaction)
        .input('templateId', sql.UniqueIdentifier, templateId)
        .input('fileName', sql.NVarChar(260), image.fileName)
        .input('mimeType', sql.NVarChar(100), image.mimeType)
        .input('content', sql.VarBinary(sql.MAX), image.content)
        .input('sortOrder', sql.Int, image.sortOrder ?? i)
        .query(`
          INSERT INTO dbo.TemplateImages (TemplateId, FileName, MimeType, Content, SortOrder)
          VALUES (@templateId, @fileName, @mimeType, @content, @sortOrder);
        `);
    }

    return getTemplateById(templateId);
  });
}

async function updateTemplate(templateId, { title, body, targetPostUrl, notes, isActive, images, replaceImages }) {
  return withTransaction(async (transaction) => {
    await new sql.Request(transaction)
      .input('templateId', sql.UniqueIdentifier, templateId)
      .input('title', sql.NVarChar(200), title)
      .input('body', sql.NVarChar(sql.MAX), body)
      .input('targetPostUrl', sql.NVarChar(2048), targetPostUrl || null)
      .input('notes', sql.NVarChar(1000), notes || null)
      .input('isActive', sql.Bit, isActive ? 1 : 0)
      .query(`
        UPDATE dbo.CommentTemplates
        SET Title = @title,
            Body = @body,
            TargetPostUrl = @targetPostUrl,
            Notes = @notes,
            IsActive = @isActive,
            UpdatedAt = SYSUTCDATETIME()
        WHERE TemplateId = @templateId;
      `);

    if (replaceImages) {
      await new sql.Request(transaction)
        .input('templateId', sql.UniqueIdentifier, templateId)
        .query('DELETE FROM dbo.TemplateImages WHERE TemplateId = @templateId;');
    }

    if (Array.isArray(images) && images.length > 0) {
      let sortOrder = 0;
      for (const image of images) {
        await new sql.Request(transaction)
          .input('templateId', sql.UniqueIdentifier, templateId)
          .input('fileName', sql.NVarChar(260), image.fileName)
          .input('mimeType', sql.NVarChar(100), image.mimeType)
          .input('content', sql.VarBinary(sql.MAX), image.content)
          .input('sortOrder', sql.Int, image.sortOrder ?? sortOrder)
          .query(`
            INSERT INTO dbo.TemplateImages (TemplateId, FileName, MimeType, Content, SortOrder)
            VALUES (@templateId, @fileName, @mimeType, @content, @sortOrder);
          `);
        sortOrder += 1;
      }
    }

    return getTemplateById(templateId);
  });
}

async function deleteTemplate(templateId) {
  const pool = await getPool();
  await pool.request()
    .input('templateId', sql.UniqueIdentifier, templateId)
    .query('DELETE FROM dbo.CommentTemplates WHERE TemplateId = @templateId;');
  return true;
}

async function getTemplateImage(templateId, imageId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('templateId', sql.UniqueIdentifier, templateId)
    .input('imageId', sql.UniqueIdentifier, imageId)
    .query(`
      SELECT TOP 1
        ImageId,
        TemplateId,
        FileName,
        MimeType,
        Content,
        SortOrder,
        CreatedAt
      FROM dbo.TemplateImages
      WHERE TemplateId = @templateId AND ImageId = @imageId;
    `);

  return result.recordset[0] || null;
}

module.exports = {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getTemplateImage
};