import { describe, expect, it } from "vitest";
import { deriveTags, mergeTags, tagsWithDerived } from "../src/tags.js";

describe("deriveTags", () => {
  it("derives canonical domain tags from free text", () => {
    const tags = deriveTags(
      "Spark ETL jobs on Databricks write parquet to S3 for the Airflow DAG.",
    );
    expect(tags).toContain("spark");
    expect(tags).toContain("etl");
    expect(tags).toContain("airflow");
    expect(tags).toContain("databricks");
    expect(tags).toContain("s3");
  });

  it("matches whole words only", () => {
    expect(deriveTags("Sparkling water and dagger design")).toEqual([]);
  });

  it("returns nothing for blank text", () => {
    expect(deriveTags("   ")).toEqual([]);
  });

  it("caps derived tags", () => {
    const tags = deriveTags(
      "spark etl airflow databricks firebolt sql python typescript npm docker k8s terraform",
      3,
    );
    expect(tags).toEqual(["spark", "etl", "airflow"]);
  });
});

describe("mergeTags", () => {
  it("keeps explicit tags first and drops case-insensitive duplicates", () => {
    expect(mergeTags(["Spark", "custom"], ["spark", "etl"])).toEqual([
      "Spark",
      "custom",
      "etl",
    ]);
  });

  it("ignores blank tags and honours the cap", () => {
    expect(mergeTags(["  ", "one"], ["two", "three"], 2)).toEqual([
      "one",
      "two",
    ]);
  });
});

describe("tagsWithDerived", () => {
  it("adds derived tags to caller tags", () => {
    expect(
      tagsWithDerived({
        title: "Pytest layout",
        content: "Run unit tests with pytest before pushing a merge request.",
        tags: ["convention"],
      }),
    ).toEqual(["convention", "git", "testing"]);
  });
});
