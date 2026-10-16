import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMusicToMedia1791981896913 implements MigrationInterface {
  name = 'AddMusicToMedia1791981896913';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_f8233358694d1677a67899b90a"`);
    await queryRunner.query(`DROP INDEX "IDX_5d6218de4f547909391a5c1347"`);
    await queryRunner.query(`DROP INDEX "IDX_c730c2d67f271a372c39a07b7e"`);
    await queryRunner.query(`DROP INDEX "IDX_7ff2d11f6a83cb52386eaebe74"`);
    await queryRunner.query(`DROP INDEX "IDX_41a289eb1fa489c1bc6f38d9c3"`);
    await queryRunner.query(`DROP INDEX "IDX_7157aad07c73f6a6ae3bbd5ef5"`);
    await queryRunner.query(
      `CREATE TABLE "temporary_media" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaType" varchar NOT NULL, "tmdbId" integer NOT NULL, "tvdbId" integer, "imdbId" varchar, "status" integer NOT NULL DEFAULT (1), "status4k" integer NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "lastSeasonChange" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "mediaAddedAt" datetime DEFAULT (CURRENT_TIMESTAMP), "serviceId" integer, "serviceId4k" integer, "externalServiceId" integer, "externalServiceId4k" integer, "externalServiceSlug" varchar, "externalServiceSlug4k" varchar, "ratingKey" varchar, "ratingKey4k" varchar, "jellyfinMediaId" varchar, "jellyfinMediaId4k" varchar, "musicBrainzId" varchar, "musicKind" varchar, "artistMusicBrainzId" varchar, CONSTRAINT "UQ_41a289eb1fa489c1bc6f38d9c3c" UNIQUE ("tvdbId"))`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_media"("id", "mediaType", "tmdbId", "tvdbId", "imdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt", "serviceId", "serviceId4k", "externalServiceId", "externalServiceId4k", "externalServiceSlug", "externalServiceSlug4k", "ratingKey", "ratingKey4k", "jellyfinMediaId", "jellyfinMediaId4k") SELECT "id", "mediaType", "tmdbId", "tvdbId", "imdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt", "serviceId", "serviceId4k", "externalServiceId", "externalServiceId4k", "externalServiceSlug", "externalServiceSlug4k", "ratingKey", "ratingKey4k", "jellyfinMediaId", "jellyfinMediaId4k" FROM "media"`
    );
    await queryRunner.query(`DROP TABLE "media"`);
    await queryRunner.query(`ALTER TABLE "temporary_media" RENAME TO "media"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_f8233358694d1677a67899b90a" ON "media" ("tmdbId", "mediaType") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5d6218de4f547909391a5c1347" ON "media" ("status4k") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c730c2d67f271a372c39a07b7e" ON "media" ("status") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7ff2d11f6a83cb52386eaebe74" ON "media" ("imdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_41a289eb1fa489c1bc6f38d9c3" ON "media" ("tvdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7157aad07c73f6a6ae3bbd5ef5" ON "media" ("tmdbId") `
    );
    await queryRunner.query(`DROP INDEX "IDX_f8233358694d1677a67899b90a"`);
    await queryRunner.query(`DROP INDEX "IDX_5d6218de4f547909391a5c1347"`);
    await queryRunner.query(`DROP INDEX "IDX_c730c2d67f271a372c39a07b7e"`);
    await queryRunner.query(`DROP INDEX "IDX_7ff2d11f6a83cb52386eaebe74"`);
    await queryRunner.query(`DROP INDEX "IDX_41a289eb1fa489c1bc6f38d9c3"`);
    await queryRunner.query(`DROP INDEX "IDX_7157aad07c73f6a6ae3bbd5ef5"`);
    await queryRunner.query(
      `CREATE TABLE "temporary_media" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaType" varchar NOT NULL, "tmdbId" integer, "tvdbId" integer, "imdbId" varchar, "status" integer NOT NULL DEFAULT (1), "status4k" integer NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "lastSeasonChange" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "mediaAddedAt" datetime DEFAULT (CURRENT_TIMESTAMP), "serviceId" integer, "serviceId4k" integer, "externalServiceId" integer, "externalServiceId4k" integer, "externalServiceSlug" varchar, "externalServiceSlug4k" varchar, "ratingKey" varchar, "ratingKey4k" varchar, "jellyfinMediaId" varchar, "jellyfinMediaId4k" varchar, "musicBrainzId" varchar, "musicKind" varchar, "artistMusicBrainzId" varchar, CONSTRAINT "UQ_41a289eb1fa489c1bc6f38d9c3c" UNIQUE ("tvdbId"))`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_media"("id", "mediaType", "tmdbId", "tvdbId", "imdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt", "serviceId", "serviceId4k", "externalServiceId", "externalServiceId4k", "externalServiceSlug", "externalServiceSlug4k", "ratingKey", "ratingKey4k", "jellyfinMediaId", "jellyfinMediaId4k", "musicBrainzId", "musicKind", "artistMusicBrainzId") SELECT "id", "mediaType", "tmdbId", "tvdbId", "imdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt", "serviceId", "serviceId4k", "externalServiceId", "externalServiceId4k", "externalServiceSlug", "externalServiceSlug4k", "ratingKey", "ratingKey4k", "jellyfinMediaId", "jellyfinMediaId4k", "musicBrainzId", "musicKind", "artistMusicBrainzId" FROM "media"`
    );
    await queryRunner.query(`DROP TABLE "media"`);
    await queryRunner.query(`ALTER TABLE "temporary_media" RENAME TO "media"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_5d6218de4f547909391a5c1347" ON "media" ("status4k") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c730c2d67f271a372c39a07b7e" ON "media" ("status") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7ff2d11f6a83cb52386eaebe74" ON "media" ("imdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_41a289eb1fa489c1bc6f38d9c3" ON "media" ("tvdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7157aad07c73f6a6ae3bbd5ef5" ON "media" ("tmdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2a9ab4d84285545ceae7da0260" ON "media" ("artistMusicBrainzId") `
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_4fb132a8fd479aa5a55aa7e50a" ON "media" ("musicBrainzId", "musicKind") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f8233358694d1677a67899b90a" ON "media" ("tmdbId", "mediaType") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_f8233358694d1677a67899b90a"`);
    await queryRunner.query(`DROP INDEX "IDX_4fb132a8fd479aa5a55aa7e50a"`);
    await queryRunner.query(`DROP INDEX "IDX_2a9ab4d84285545ceae7da0260"`);
    await queryRunner.query(`DROP INDEX "IDX_7157aad07c73f6a6ae3bbd5ef5"`);
    await queryRunner.query(`DROP INDEX "IDX_41a289eb1fa489c1bc6f38d9c3"`);
    await queryRunner.query(`DROP INDEX "IDX_7ff2d11f6a83cb52386eaebe74"`);
    await queryRunner.query(`DROP INDEX "IDX_c730c2d67f271a372c39a07b7e"`);
    await queryRunner.query(`DROP INDEX "IDX_5d6218de4f547909391a5c1347"`);
    await queryRunner.query(`ALTER TABLE "media" RENAME TO "temporary_media"`);
    await queryRunner.query(
      `CREATE TABLE "media" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaType" varchar NOT NULL, "tmdbId" integer NOT NULL, "tvdbId" integer, "imdbId" varchar, "status" integer NOT NULL DEFAULT (1), "status4k" integer NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "lastSeasonChange" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "mediaAddedAt" datetime DEFAULT (CURRENT_TIMESTAMP), "serviceId" integer, "serviceId4k" integer, "externalServiceId" integer, "externalServiceId4k" integer, "externalServiceSlug" varchar, "externalServiceSlug4k" varchar, "ratingKey" varchar, "ratingKey4k" varchar, "jellyfinMediaId" varchar, "jellyfinMediaId4k" varchar, "musicBrainzId" varchar, "musicKind" varchar, "artistMusicBrainzId" varchar, CONSTRAINT "UQ_41a289eb1fa489c1bc6f38d9c3c" UNIQUE ("tvdbId"))`
    );
    await queryRunner.query(
      `INSERT INTO "media"("id", "mediaType", "tmdbId", "tvdbId", "imdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt", "serviceId", "serviceId4k", "externalServiceId", "externalServiceId4k", "externalServiceSlug", "externalServiceSlug4k", "ratingKey", "ratingKey4k", "jellyfinMediaId", "jellyfinMediaId4k", "musicBrainzId", "musicKind", "artistMusicBrainzId") SELECT "id", "mediaType", "tmdbId", "tvdbId", "imdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt", "serviceId", "serviceId4k", "externalServiceId", "externalServiceId4k", "externalServiceSlug", "externalServiceSlug4k", "ratingKey", "ratingKey4k", "jellyfinMediaId", "jellyfinMediaId4k", "musicBrainzId", "musicKind", "artistMusicBrainzId" FROM "temporary_media"`
    );
    await queryRunner.query(`DROP TABLE "temporary_media"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_7157aad07c73f6a6ae3bbd5ef5" ON "media" ("tmdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_41a289eb1fa489c1bc6f38d9c3" ON "media" ("tvdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7ff2d11f6a83cb52386eaebe74" ON "media" ("imdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c730c2d67f271a372c39a07b7e" ON "media" ("status") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5d6218de4f547909391a5c1347" ON "media" ("status4k") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f8233358694d1677a67899b90a" ON "media" ("tmdbId", "mediaType") `
    );
    await queryRunner.query(`DROP INDEX "IDX_7157aad07c73f6a6ae3bbd5ef5"`);
    await queryRunner.query(`DROP INDEX "IDX_41a289eb1fa489c1bc6f38d9c3"`);
    await queryRunner.query(`DROP INDEX "IDX_7ff2d11f6a83cb52386eaebe74"`);
    await queryRunner.query(`DROP INDEX "IDX_c730c2d67f271a372c39a07b7e"`);
    await queryRunner.query(`DROP INDEX "IDX_5d6218de4f547909391a5c1347"`);
    await queryRunner.query(`DROP INDEX "IDX_f8233358694d1677a67899b90a"`);
    await queryRunner.query(`ALTER TABLE "media" RENAME TO "temporary_media"`);
    await queryRunner.query(
      `CREATE TABLE "media" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaType" varchar NOT NULL, "tmdbId" integer NOT NULL, "tvdbId" integer, "imdbId" varchar, "status" integer NOT NULL DEFAULT (1), "status4k" integer NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "lastSeasonChange" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "mediaAddedAt" datetime DEFAULT (CURRENT_TIMESTAMP), "serviceId" integer, "serviceId4k" integer, "externalServiceId" integer, "externalServiceId4k" integer, "externalServiceSlug" varchar, "externalServiceSlug4k" varchar, "ratingKey" varchar, "ratingKey4k" varchar, "jellyfinMediaId" varchar, "jellyfinMediaId4k" varchar, CONSTRAINT "UQ_41a289eb1fa489c1bc6f38d9c3c" UNIQUE ("tvdbId"))`
    );
    await queryRunner.query(
      `INSERT INTO "media"("id", "mediaType", "tmdbId", "tvdbId", "imdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt", "serviceId", "serviceId4k", "externalServiceId", "externalServiceId4k", "externalServiceSlug", "externalServiceSlug4k", "ratingKey", "ratingKey4k", "jellyfinMediaId", "jellyfinMediaId4k") SELECT "id", "mediaType", "tmdbId", "tvdbId", "imdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt", "serviceId", "serviceId4k", "externalServiceId", "externalServiceId4k", "externalServiceSlug", "externalServiceSlug4k", "ratingKey", "ratingKey4k", "jellyfinMediaId", "jellyfinMediaId4k" FROM "temporary_media"`
    );
    await queryRunner.query(`DROP TABLE "temporary_media"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_7157aad07c73f6a6ae3bbd5ef5" ON "media" ("tmdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_41a289eb1fa489c1bc6f38d9c3" ON "media" ("tvdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7ff2d11f6a83cb52386eaebe74" ON "media" ("imdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c730c2d67f271a372c39a07b7e" ON "media" ("status") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5d6218de4f547909391a5c1347" ON "media" ("status4k") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f8233358694d1677a67899b90a" ON "media" ("tmdbId", "mediaType") `
    );
  }
}
