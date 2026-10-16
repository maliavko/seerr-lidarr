import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMusicToMedia1791982081339 implements MigrationInterface {
  name = 'AddMusicToMedia1791982081339';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media" ADD "musicBrainzId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD "musicKind" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD "artistMusicBrainzId" character varying`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f8233358694d1677a67899b90a"`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ALTER COLUMN "tmdbId" DROP NOT NULL`
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
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f8233358694d1677a67899b90a"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_4fb132a8fd479aa5a55aa7e50a"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2a9ab4d84285545ceae7da0260"`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ALTER COLUMN "tmdbId" SET NOT NULL`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f8233358694d1677a67899b90a" ON "media" ("mediaType", "tmdbId") `
    );
    await queryRunner.query(
      `ALTER TABLE "media" DROP COLUMN "artistMusicBrainzId"`
    );
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "musicKind"`);
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "musicBrainzId"`);
  }
}
