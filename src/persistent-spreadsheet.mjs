import AppError from "./app-error.mjs";
import MemSpreadsheet from "./mem-spreadsheet.mjs";

//use for development only
import { inspect } from "util";

import mongo from "mongodb";

//use in mongo.connect() to avoid warning
const MONGO_CONNECT_OPTIONS = { useUnifiedTopology: true };

/**
 * User errors must be reported by throwing a suitable
 * AppError object having a suitable message property
 * and code property set as follows:
 *
 *  `SYNTAX`: for a syntax error.
 *  `CIRCULAR_REF` for a circular reference.
 *  `DB`: database error.
 */

export default class PersistentSpreadsheet {
  //factory method
  static async make(dbUrl, spreadsheetName) {
    try {
      //@TODO set up database info, including reading data
      const client = await mongo.connect(dbUrl, MONGO_CONNECT_OPTIONS);
      const db = client.db();
      const collection = db.collection(spreadsheetName);
      //console.log("Connected");

      const mem = new MemSpreadsheet();
      return new PersistentSpreadsheet(db, client, collection, mem);
    } catch (err) {
      const msg = `cannot connect to URL "${dbUrl}": ${err}`;
      throw new AppError("DB", msg);
    }
    // return new PersistentSpreadsheet(client, cellInfo);
  }

  constructor(/* @TODO params */ db, client, collection, mem) {
    //@TODO
    this.db = db;
    this.collection = collection;
    this.client = client;
    this.mem = mem;
    this.baseCellId = "";
    this.formula = "";
  }

  //function used for creating entry in DB
  async create(basecellId, formula) {
    try {
      //console.log("Created", basecellId, formula);
      await this.collection.insertOne({
        id: basecellId,
        formula: formula,
      });
    } catch (err) {}
  }

  // function used for reading values and evaluting before performing any operation
  async read() {
    try {
      const result = await this.collection.find({}).toArray();
      for (let i = 0; i < result.length; i++) {
        this.mem.eval(result[i].id, result[i].formula);
      }
      return result;
    } catch (err) {}
  }

  /** Release all resources held by persistent spreadsheet.
   *  Specifically, close any database connections.
   */
  async close() {
    //@TODO
    try {
      await this.client.close();
    } catch (err) {
      throw new UserError("DB", err.toString());
    }
  }

  /** Set cell with id baseCellId to result of evaluating string
   *  formula.  Update all cells which are directly or indirectly
   *  dependent on the base cell.  Return an object mapping the id's
   *  of all dependent cells to their updated values.
   */

  // first delegates to mem then creates and entry in DB
  async eval(baseCellId, formula) {
    await this.read();
    const results = /* @TODO delegate to in-memory spreadsheet */ this.mem.eval(
      baseCellId,
      formula
    );
    try {
      //@TODO
      this.baseCellId = baseCellId;
      await this.create(this.baseCellId, formula); // if everything is good then creates entry
    } catch (err) {
      //@TODO undo mem-spreadsheet operation
      const msg = `cannot update "${baseCellId}: ${err}`;
      throw new AppError("DB", msg);
    }
    return results;
  }

  /** return object containing formula and value for cell cellId
   *  return { value: 0, formula: '' } for an empty cell.
   */
  //delegates to mem
  async query(cellId) {
    await this.read();
    try {
      return this.mem.query(cellId);
    } catch (error) {
      return this.mem.query(cellId, "");
    }
  }

  /** Clear contents of this spreadsheet */
  async clear() {
    await this.read();
    try {
      //@TODO
      const result = await this.collection.deleteMany({}); //to delete everything in that collection
    } catch (err) {
      const msg = `cannot drop collection ${this.spreadsheetName}: ${err}`;
      throw new AppError("DB", msg);
    }
    /* @TODO delegate to in-memory spreadsheet */
    this.mem.clear();
  }

  /** Delete all info for cellId from this spreadsheet. Return an
   *  object mapping the id's of all dependent cells to their updated
   *  values.
   */
  async delete(cellId) {
    await this.read();
    let results;
    results = /* @TODO delegate to in-memory spreadsheet */ this.mem.delete(
      cellId
    );
    try {
      //@TODO
      await this.collection.deleteMany({ id: cellId });
    } catch (err) {
      //@TODO undo mem-spreadsheet operation
      this.mem.undo();
      const msg = `cannot delete ${cellId}: ${err}`;
      throw new AppError("DB", msg);
    }
    return results;
  }

  /** copy formula from srcCellId to destCellId, adjusting any
   *  relative cell references suitably.  Return an object mapping the
   *  id's of all dependent cells to their updated values. Copying
   *  an empty cell is equivalent to deleting the destination cell.
   */
  async copy(destCellId, srcCellId) {
    await this.read();
    const srcFormula = /* @TODO get formula by querying mem-spreadsheet */ this.mem.query_formula(
      srcCellId
    );
    const destFormula = this.mem.query_formula(destCellId);
    //console.log(srcFormula.formula);
    if (!srcFormula) {
      return await this.delete(destCellId);
    } else {
      const results = /* @TODO delegate to in-memory spreadsheet */ this.mem.copy(
        destCellId,
        srcCellId
      );
      try {
        //@TODO
        // update that specific destCellId and set formula using updateOne
        // if the destCell is not present in database then created it using insertOne
        if (destFormula.formula !== "") {
          //console.log("Entered destcellCopy");
          await this.collection.updateOne(
            {
              id: destCellId,
            },
            { $set: { formula: srcFormula.formula } }
          );
        } else {
          //console.log("Created DestCellId");
          await this.collection.insertOne({
            id: destCellId,
            formula: srcFormula.formula,
          });
        }
      } catch (err) {
        //@TODO undo mem-spreadsheet operation
        this.mem.undo();
        const msg = `cannot update "${destCellId}: ${err}`;
        throw new AppError("DB", msg);
      }
      return results;
    }
  }

  /** Return dump of cell values as list of cellId and formula pairs.
   *  Do not include any cell's with empty formula.
   *
   *  Returned list must be sorted by cellId with primary order being
   *  topological (cell A < cell B when B depends on A) and secondary
   *  order being lexicographical (when cells have no dependency
   *  relation).
   *
   *  Specifically, the cells must be dumped in a non-decreasing depth
   *  order:
   *
   *    + The depth of a cell with no dependencies is 0.
   *
   *    + The depth of a cell C with direct prerequisite cells
   *      C1, ..., Cn is max(depth(C1), .... depth(Cn)) + 1.
   *
   *  Cells having the same depth must be sorted in lexicographic order
   *  by their IDs.
   *
   *  Note that empty cells must be ignored during the topological
   *  sort.
   */
  async dump() {
    await this.read();
    return /* @TODO delegate to in-memory spreadsheet */ this.mem.dump();
  }
}

//@TODO auxiliary functions
