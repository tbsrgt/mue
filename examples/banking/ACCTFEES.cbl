       IDENTIFICATION DIVISION.
       PROGRAM-ID. ACCTFEES.
       AUTHOR. RETAIL TEAM.
       DATE-WRITTEN. 1996.
      *----------------------------------------------------------------
      * ACCOUNT MAINTENANCE FEES BY AVERAGE BALANCE AND SEGMENT
      * 15 % DISCOUNT FOR PREMIUM CUSTOMERS.
      * MUE EXAMPLE - FICTIONAL SYSTEM
      *----------------------------------------------------------------
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       77  WS-I                    PIC 9(2).
       77  WS-MONTHLY-FEE          PIC 9(3)V99.
       77  WS-DISCOUNT             PIC 9(3)V99.
       LINKAGE SECTION.
       01  LK-FEES.
           05  LK-AVG-BALANCE      PIC S9(9)V99  COMP-3.
      *    NUMBER OF MONTHS BILLED
           05  LK-MONTHS           PIC 9(2).
      *    SEGMENT : YTH = YOUTH, PRE / PRV = PREMIUM
           05  LK-SEGMENT          PIC X(3).
               88  SEG-YOUTH       VALUE 'YTH'.
               88  SEG-PREMIUM     VALUE 'PRE' 'PRV'.
           05  LK-TOTAL-FEES       PIC 9(5)V99   COMP-3.
       PROCEDURE DIVISION USING LK-FEES.
       0000-MAIN.
           MOVE ZERO TO LK-TOTAL-FEES
           EVALUATE TRUE
              WHEN SEG-YOUTH
                 MOVE ZERO TO WS-MONTHLY-FEE
              WHEN LK-AVG-BALANCE < ZERO
                 MOVE 8.50 TO WS-MONTHLY-FEE
              WHEN LK-AVG-BALANCE < 1500
                 MOVE 4.20 TO WS-MONTHLY-FEE
              WHEN OTHER
                 MOVE 2.00 TO WS-MONTHLY-FEE
           END-EVALUATE
           PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > LK-MONTHS
              ADD WS-MONTHLY-FEE TO LK-TOTAL-FEES
           END-PERFORM
           IF SEG-PREMIUM
              COMPUTE WS-DISCOUNT = LK-TOTAL-FEES * 0.15
              SUBTRACT WS-DISCOUNT FROM LK-TOTAL-FEES
           END-IF
           GOBACK.
