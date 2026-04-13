IF DB_ID(N'CommentAssistant') IS NULL
BEGIN
  EXEC('CREATE DATABASE [CommentAssistant]');
END
GO

USE [CommentAssistant];
GO

CREATE TABLE dbo.CommentTemplates (
  TemplateId uniqueidentifier NOT NULL DEFAULT NEWID(),
  Title nvarchar(200) NOT NULL,
  Body nvarchar(max) NOT NULL,
  TargetPostUrl nvarchar(2048) NULL,
  Notes nvarchar(1000) NULL,
  IsActive bit NOT NULL DEFAULT (1),
  CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UpdatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY (TemplateId)
);

CREATE TABLE dbo.TemplateImages (
  ImageId uniqueidentifier NOT NULL DEFAULT NEWID(),
  TemplateId uniqueidentifier NOT NULL,
  FileName nvarchar(260) NOT NULL,
  MimeType nvarchar(100) NOT NULL,
  Content varbinary(max) NOT NULL,
  SortOrder int NOT NULL DEFAULT (0),
  CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY (ImageId),
  FOREIGN KEY (TemplateId)
    REFERENCES dbo.CommentTemplates (TemplateId)
    ON DELETE CASCADE
);

CREATE TABLE dbo.CommentJobs (
  JobId uniqueidentifier NOT NULL DEFAULT NEWID(),
  TemplateId uniqueidentifier NOT NULL,
  TargetPostUrl nvarchar(2048) NOT NULL,
  Status tinyint NOT NULL DEFAULT (0),
  LastMessage nvarchar(max) NULL,
  ScheduledAt datetime2 NULL,
  StartedAt datetime2 NULL,
  FinishedAt datetime2 NULL,
  CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UpdatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY (JobId),
  FOREIGN KEY (TemplateId)
    REFERENCES dbo.CommentTemplates (TemplateId)
    ON DELETE CASCADE
);

CREATE INDEX IX_CommentJobs_Status_CreatedAt ON dbo.CommentJobs (Status, CreatedAt DESC);

CREATE TABLE dbo.CommentJobLogs (
  LogId uniqueidentifier NOT NULL DEFAULT NEWID(),
  JobId uniqueidentifier NOT NULL,
  Level nvarchar(20) NOT NULL,
  Message nvarchar(max) NOT NULL,
  CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY (LogId),
  FOREIGN KEY (JobId)
    REFERENCES dbo.CommentJobs (JobId)
    ON DELETE CASCADE
);
