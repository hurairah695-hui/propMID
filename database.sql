/* =====================================================================
   PropDeal - database schema for Microsoft SQL Server 2014 (and newer)
   Run this whole file once in SSMS (or: sqlcmd -S localhost -E -i database.sql)
   It is safe to run again: existing tables are left untouched.
   NOTE: no SQL 2016+ features are used (no DROP IF EXISTS, no JSON functions).
   ===================================================================== */

IF DB_ID(N'PropDealDB') IS NULL
    CREATE DATABASE PropDealDB;
GO

USE PropDealDB;
GO

/* ---------- Users : every account (buyer, seller, admin) ---------- */
IF OBJECT_ID(N'dbo.Users', N'U') IS NULL
CREATE TABLE dbo.Users (
    Id              INT IDENTITY(1,1)  NOT NULL CONSTRAINT PK_Users PRIMARY KEY,
    Name            NVARCHAR(100)      NOT NULL,
    Email           NVARCHAR(255)      NOT NULL,
    PasswordHash    NVARCHAR(255)      NOT NULL,          -- bcrypt hash, never the real password
    Role            NVARCHAR(10)       NOT NULL,
    Age             INT                NULL,
    City            NVARCHAR(80)       NULL,
    Phone           NVARCHAR(30)       NULL,
    About           NVARCHAR(1000)     NULL,
    BudgetMin       BIGINT             NULL,              -- buyers
    BudgetMax       BIGINT             NULL,              -- buyers
    AgencyName      NVARCHAR(120)      NULL,              -- sellers
    ExperienceYears INT                NULL,              -- sellers
    IsActive        BIT                NOT NULL CONSTRAINT DF_Users_IsActive DEFAULT (1),
    CreatedAt       DATETIME2(0)       NOT NULL CONSTRAINT DF_Users_CreatedAt DEFAULT (SYSUTCDATETIME()),
    LastLoginAt     DATETIME2(0)       NULL,
    CONSTRAINT UQ_Users_Email UNIQUE (Email),
    CONSTRAINT CK_Users_Role  CHECK (Role IN (N'buyer', N'seller', N'admin'))
);
GO

/* ---------- Admin : extra details for accounts whose Role = 'admin' ---------- */
IF OBJECT_ID(N'dbo.Admin', N'U') IS NULL
CREATE TABLE dbo.Admin (
    Id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Admin PRIMARY KEY,
    UserId      INT               NOT NULL,
    AdminLevel  NVARCHAR(20)      NOT NULL CONSTRAINT DF_Admin_Level DEFAULT (N'super'),
    CreatedAt   DATETIME2(0)      NOT NULL CONSTRAINT DF_Admin_CreatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_Admin_User UNIQUE (UserId),
    CONSTRAINT FK_Admin_Users FOREIGN KEY (UserId) REFERENCES dbo.Users(Id) ON DELETE CASCADE
);
GO

/* ---------- Properties ---------- */
IF OBJECT_ID(N'dbo.Properties', N'U') IS NULL
CREATE TABLE dbo.Properties (
    Id              INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Properties PRIMARY KEY,
    OwnerId         INT               NOT NULL,           -- the seller
    Title           NVARCHAR(150)     NOT NULL,
    Type            NVARCHAR(15)      NOT NULL,
    Mode            NVARCHAR(10)      NOT NULL,
    Price           BIGINT            NOT NULL,
    Negotiable      BIT               NULL,
    Months          INT               NULL,               -- minimum rental months
    City            NVARCHAR(80)      NOT NULL,
    Locality        NVARCHAR(150)     NULL,
    AreaSize        NVARCHAR(60)      NULL,
    Beds            INT               NULL,
    Baths           INT               NULL,
    Description     NVARCHAR(500)     NULL,
    LongDescription NVARCHAR(MAX)     NULL,
    ApprovalStatus  NVARCHAR(10)      NOT NULL CONSTRAINT DF_Prop_Status DEFAULT (N'approved'),
    Features        NVARCHAR(MAX)     NULL,               -- JSON text, e.g. ["Lawn","Garage"]
    Images          NVARCHAR(MAX)     NULL,               -- JSON text, list of image URLs / data URLs
    CreatedAt       DATETIME2(0)      NOT NULL CONSTRAINT DF_Prop_CreatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT FK_Prop_Owner  FOREIGN KEY (OwnerId) REFERENCES dbo.Users(Id) ON DELETE CASCADE,
    CONSTRAINT CK_Prop_Type   CHECK (Type IN (N'house', N'apartment', N'shop', N'plot')),
    CONSTRAINT CK_Prop_Mode   CHECK (Mode IN (N'sale', N'rent')),
    CONSTRAINT CK_Prop_Status CHECK (ApprovalStatus IN (N'approved', N'pending', N'rejected')),
    CONSTRAINT CK_Prop_Price  CHECK (Price > 0)
);
GO

/* ---------- Meetings (viewing requests) ---------- */
IF OBJECT_ID(N'dbo.Meetings', N'U') IS NULL
CREATE TABLE dbo.Meetings (
    Id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Meetings PRIMARY KEY,
    PropertyId  INT               NOT NULL,
    BuyerId     INT               NOT NULL,
    SellerId    INT               NOT NULL,
    MeetingDate DATE              NOT NULL,
    MeetingTime NVARCHAR(20)      NOT NULL,
    Note        NVARCHAR(1000)    NULL,
    Months      INT               NULL,
    Status      NVARCHAR(12)      NOT NULL CONSTRAINT DF_Meet_Status DEFAULT (N'pending'),
    CreatedAt   DATETIME2(0)      NOT NULL CONSTRAINT DF_Meet_CreatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT FK_Meet_Property FOREIGN KEY (PropertyId) REFERENCES dbo.Properties(Id) ON DELETE CASCADE,
    CONSTRAINT FK_Meet_Buyer    FOREIGN KEY (BuyerId)    REFERENCES dbo.Users(Id),
    CONSTRAINT FK_Meet_Seller   FOREIGN KEY (SellerId)   REFERENCES dbo.Users(Id),
    CONSTRAINT CK_Meet_Status   CHECK (Status IN (N'pending', N'confirmed', N'declined', N'completed', N'cancelled'))
);
GO

/* ---------- Deals (offers + pipeline) ---------- */
IF OBJECT_ID(N'dbo.Deals', N'U') IS NULL
CREATE TABLE dbo.Deals (
    Id           INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Deals PRIMARY KEY,
    PropertyId   INT               NOT NULL,
    BuyerId      INT               NOT NULL,
    SellerId     INT               NOT NULL,
    OfferedPrice BIGINT            NOT NULL,
    Stage        NVARCHAR(20)      NOT NULL CONSTRAINT DF_Deal_Stage DEFAULT (N'inquiry'),
    Notes        NVARCHAR(1000)    NULL,
    CreatedAt    DATETIME2(0)      NOT NULL CONSTRAINT DF_Deal_CreatedAt DEFAULT (SYSUTCDATETIME()),
    UpdatedAt    DATETIME2(0)      NOT NULL CONSTRAINT DF_Deal_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT FK_Deal_Property FOREIGN KEY (PropertyId) REFERENCES dbo.Properties(Id) ON DELETE CASCADE,
    CONSTRAINT FK_Deal_Buyer    FOREIGN KEY (BuyerId)    REFERENCES dbo.Users(Id),
    CONSTRAINT FK_Deal_Seller   FOREIGN KEY (SellerId)   REFERENCES dbo.Users(Id),
    CONSTRAINT CK_Deal_Stage    CHECK (Stage IN (N'inquiry', N'viewing_scheduled', N'negotiation', N'offer_accepted', N'closed', N'cancelled'))
);
GO

/* ---------- Reviews (moderated by admin) ---------- */
IF OBJECT_ID(N'dbo.Reviews', N'U') IS NULL
CREATE TABLE dbo.Reviews (
    Id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Reviews PRIMARY KEY,
    PropertyId  INT               NOT NULL,
    BuyerId     INT               NOT NULL,
    Rating      TINYINT           NOT NULL,
    Comment     NVARCHAR(1000)    NOT NULL,
    Status      NVARCHAR(10)      NOT NULL CONSTRAINT DF_Rev_Status DEFAULT (N'pending'),
    CreatedAt   DATETIME2(0)      NOT NULL CONSTRAINT DF_Rev_CreatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT FK_Rev_Property FOREIGN KEY (PropertyId) REFERENCES dbo.Properties(Id) ON DELETE CASCADE,
    CONSTRAINT FK_Rev_Buyer    FOREIGN KEY (BuyerId)    REFERENCES dbo.Users(Id),
    CONSTRAINT CK_Rev_Rating   CHECK (Rating BETWEEN 1 AND 5),
    CONSTRAINT CK_Rev_Status   CHECK (Status IN (N'pending', N'approved', N'rejected'))
);
GO

/* ---------- Favorites (saved properties) ---------- */
IF OBJECT_ID(N'dbo.Favorites', N'U') IS NULL
CREATE TABLE dbo.Favorites (
    UserId      INT          NOT NULL,
    PropertyId  INT          NOT NULL,
    CreatedAt   DATETIME2(0) NOT NULL CONSTRAINT DF_Fav_CreatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_Favorites PRIMARY KEY (UserId, PropertyId),
    CONSTRAINT FK_Fav_User     FOREIGN KEY (UserId)     REFERENCES dbo.Users(Id),
    CONSTRAINT FK_Fav_Property FOREIGN KEY (PropertyId) REFERENCES dbo.Properties(Id) ON DELETE CASCADE
);
GO

/* ---------- Announcements (red ticker on the buyer view) ---------- */
IF OBJECT_ID(N'dbo.Announcements', N'U') IS NULL
CREATE TABLE dbo.Announcements (
    Id        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Announcements PRIMARY KEY,
    Message   NVARCHAR(500)     NOT NULL,
    SortOrder INT               NOT NULL CONSTRAINT DF_Ann_Sort DEFAULT (0),
    IsActive  BIT               NOT NULL CONSTRAINT DF_Ann_Active DEFAULT (1)
);
GO

/* ---------- AppSettings (promo discount + enabled colour themes, stored as JSON text) ---------- */
IF OBJECT_ID(N'dbo.AppSettings', N'U') IS NULL
CREATE TABLE dbo.AppSettings (
    SettingKey   NVARCHAR(50)  NOT NULL CONSTRAINT PK_AppSettings PRIMARY KEY,
    SettingValue NVARCHAR(MAX) NOT NULL
);
GO

/* ---------- helpful indexes ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Properties_Owner' AND object_id = OBJECT_ID(N'dbo.Properties'))
    CREATE INDEX IX_Properties_Owner ON dbo.Properties(OwnerId);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Meetings_Buyer' AND object_id = OBJECT_ID(N'dbo.Meetings'))
    CREATE INDEX IX_Meetings_Buyer ON dbo.Meetings(BuyerId);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Meetings_Seller' AND object_id = OBJECT_ID(N'dbo.Meetings'))
    CREATE INDEX IX_Meetings_Seller ON dbo.Meetings(SellerId);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Deals_Buyer' AND object_id = OBJECT_ID(N'dbo.Deals'))
    CREATE INDEX IX_Deals_Buyer ON dbo.Deals(BuyerId);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Deals_Seller' AND object_id = OBJECT_ID(N'dbo.Deals'))
    CREATE INDEX IX_Deals_Seller ON dbo.Deals(SellerId);
GO

PRINT 'PropDealDB is ready. Next: run  npm run seed  (creates demo accounts and listings).';
GO
