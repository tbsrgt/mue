       IDENTIFICATION DIVISION.
       PROGRAM-ID. STMTPRT.
       AUTHOR. PRINT SERVICES.
       DATE-WRITTEN. 1989.
      *----------------------------------------------------------------
      * MONTHLY STATEMENT PRINTING FROM THE TRANSACTIONS FILE
      * MUE EXAMPLE - FICTIONAL SYSTEM
      *----------------------------------------------------------------
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT F-TXNS   ASSIGN TO STMTIN.
           SELECT F-PRINT  ASSIGN TO STMTOUT.
       DATA DIVISION.
       FILE SECTION.
       FD  F-TXNS.
       01  TXN-REC.
           05  TXN-ACCOUNT         PIC X(11).
           05  TXN-LABEL           PIC X(30).
           05  TXN-AMOUNT          PIC S9(9)V99.
       FD  F-PRINT.
       01  PRINT-LINE              PIC X(80).
       WORKING-STORAGE SECTION.
       77  WS-EOF                  PIC X         VALUE 'N'.
       77  WS-TOTAL                PIC S9(11)V99 VALUE ZERO.
       PROCEDURE DIVISION.
       0000-MAIN.
           OPEN INPUT F-TXNS OUTPUT F-PRINT
           PERFORM 1000-READ
           PERFORM 2000-PRINT UNTIL WS-EOF = 'Y'
           CLOSE F-TXNS F-PRINT
           STOP RUN.
       1000-READ.
           READ F-TXNS
              AT END MOVE 'Y' TO WS-EOF
           END-READ.
       2000-PRINT.
           ADD TXN-AMOUNT TO WS-TOTAL
           STRING TXN-ACCOUNT ' ' TXN-LABEL DELIMITED BY SIZE
              INTO PRINT-LINE
           END-STRING
           WRITE PRINT-LINE
           PERFORM 1000-READ.
